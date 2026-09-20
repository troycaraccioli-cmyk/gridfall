/**
 * Gridfall — 3D turn-based strategy PWA (Three.js)
 * Touch-first: tap unit → tap tile to move/attack. Square grid on a 3D tabletop.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const GRID = 16;
const TILE = 1.15;
const HALF = ((GRID - 1) * TILE) / 2;

const UNIT_DEFS = {
  infantry: { name: 'Infantry', move: 3, hp: 10, atk: 4, range: 1, minRange: 1, colorPlayer: 0x3ad7ff, colorEnemy: 0xff7a3a, shape: 'knight' },
  archer:   { name: 'Archer',   move: 2, hp: 7,  atk: 3, range: 3, minRange: 2, colorPlayer: 0x7dffb0, colorEnemy: 0xffaa66, shape: 'archer' },
  bastion:  { name: 'Bastion',  move: 2, hp: 16, atk: 5, range: 1, minRange: 1, colorPlayer: 0x8ab4ff, colorEnemy: 0xff5577, shape: 'carriage' },
};

const $ = (id) => document.getElementById(id);

const ui = {
  title: $('title-screen'),
  howto: $('howto-screen'),
  end: $('end-screen'),
  hud: $('hud'),
  bottom: $('bottom-hud'),
  hint: $('camera-hint'),
  toast: $('status-toast'),
  turnNum: $('turn-num'),
  phase: $('phase-pill'),
  playerCount: $('player-count'),
  enemyCount: $('enemy-count'),
  unitInfo: $('unit-info'),
  endTitle: $('end-title'),
  endMsg: $('end-msg'),
  btnEnd: $('btn-end-turn'),
};

let scene, camera, renderer, controls, raycaster, pointer;
let boardGroup, highlightGroup, unitsGroup, crystalMesh;
let tiles = []; // {x,z,mesh,obstacle}
let units = [];
let selected = null;
let reachable = new Set();
let attackable = new Set();
let turn = 1;
let phase = 'player'; // player | ai | ended
let gameActive = false;
let toastTimer = null;

function key(x, z) { return `${x},${z}`; }

function showOverlay(el) {
  [ui.title, ui.howto, ui.end].forEach((o) => o.classList.add('hidden'));
  if (el) el.classList.remove('hidden');
}

function setHudVisible(v) {
  ui.hud.classList.toggle('hidden', !v);
  ui.bottom.classList.toggle('hidden', !v);
  ui.hint.classList.toggle('hidden', !v);
}

function toast(msg, ms = 1600) {
  ui.toast.textContent = msg;
  ui.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove('show'), ms);
}

function initThree() {
  const canvas = $('game-canvas');
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b1220);
  scene.fog = new THREE.Fog(0x0b1220, 28, 70);

  camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(18, 26, 22);

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 0.3, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 10;
  controls.maxDistance = 48;
  controls.maxPolarAngle = Math.PI * 0.46;
  controls.minPolarAngle = 0.35;
  controls.enablePan = false;
  controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };

  const amb = new THREE.AmbientLight(0x6688aa, 0.55);
  scene.add(amb);
  const sun = new THREE.DirectionalLight(0xfff0dd, 1.15);
  sun.position.set(6, 14, 4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 40;
  sun.shadow.camera.left = -12;
  sun.shadow.camera.right = 12;
  sun.shadow.camera.top = 12;
  sun.shadow.camera.bottom = -12;
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x4488ff, 0.35);
  fill.position.set(-8, 6, -6);
  scene.add(fill);

  // Table top
  const table = new THREE.Mesh(
    new THREE.BoxGeometry(GRID * TILE + 2.4, 0.45, GRID * TILE + 2.4),
    new THREE.MeshStandardMaterial({ color: 0x2a1a12, roughness: 0.85, metalness: 0.05 })
  );
  table.position.y = -0.35;
  table.receiveShadow = true;
  scene.add(table);

  const rim = new THREE.Mesh(
    new THREE.BoxGeometry(GRID * TILE + 2.8, 0.55, GRID * TILE + 2.8),
    new THREE.MeshStandardMaterial({ color: 0x1a100c, roughness: 0.9 })
  );
  rim.position.y = -0.55;
  scene.add(rim);

  boardGroup = new THREE.Group();
  highlightGroup = new THREE.Group();
  unitsGroup = new THREE.Group();
  scene.add(boardGroup, highlightGroup, unitsGroup);

  raycaster = new THREE.Raycaster();
  pointer = new THREE.Vector2();

  window.addEventListener('resize', onResize);
  canvas.addEventListener('pointerdown', onPointerDown);

  animate();
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function worldPos(gx, gz) {
  return new THREE.Vector3(gx * TILE - HALF, 0, gz * TILE - HALF);
}

function buildBoard() {
  while (boardGroup.children.length) boardGroup.remove(boardGroup.children[0]);
  tiles = [];

  // 4× prior obstacle count (5 → 20), keep spawn corners + crystal clear
  const obstacles = new Set();
  const crystalX = Math.floor(GRID / 2);
  const crystalZ = Math.floor(GRID / 2);
  const banned = new Set();
  for (let z = 0; z < 5; z++) for (let x = 0; x < 5; x++) banned.add(key(x, z));
  for (let z = GRID - 5; z < GRID; z++) for (let x = GRID - 5; x < GRID; x++) banned.add(key(x, z));
  banned.add(key(crystalX, crystalZ));
  const candidates = [];
  for (let z = 0; z < GRID; z++) {
    for (let x = 0; x < GRID; x++) {
      if (!banned.has(key(x, z))) candidates.push([x, z]);
    }
  }
  // deterministic shuffle for stable maps
  let seed = 42;
  const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  for (let i = 0; i < 20 && i < candidates.length; i++) {
    obstacles.add(key(candidates[i][0], candidates[i][1]));
  }

  for (let z = 0; z < GRID; z++) {
    for (let x = 0; x < GRID; x++) {
      const isObs = obstacles.has(key(x, z));
      const checker = (x + z) % 2 === 0;
      const geo = new THREE.BoxGeometry(TILE * 0.92, 0.18, TILE * 0.92);
      const mat = new THREE.MeshStandardMaterial({
        color: isObs ? 0x3a4558 : (checker ? 0x1e3a5f : 0x16304f),
        roughness: 0.7,
        metalness: 0.15,
      });
      const mesh = new THREE.Mesh(geo, mat);
      const p = worldPos(x, z);
      mesh.position.set(p.x, 0.05, p.z);
      mesh.receiveShadow = true;
      mesh.castShadow = true;
      mesh.userData = { type: 'tile', x, z };
      boardGroup.add(mesh);

      if (isObs) {
        const rock = new THREE.Mesh(
          new THREE.DodecahedronGeometry(0.35, 0),
          new THREE.MeshStandardMaterial({ color: 0x6a7388, roughness: 0.9 })
        );
        rock.position.set(p.x, 0.45, p.z);
        rock.castShadow = true;
        boardGroup.add(rock);
      }
      tiles.push({ x, z, mesh, obstacle: isObs });
    }
  }

  // Objective crystal at board center (crystalX/Z set above with obstacles)
  if (crystalMesh) {
    scene.remove(crystalMesh);
    crystalMesh = null;
  }
  const cp = worldPos(crystalX, crystalZ);
  const crystal = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.42, 0),
    new THREE.MeshStandardMaterial({
      color: 0xffd266,
      emissive: 0xaa7700,
      emissiveIntensity: 0.55,
      metalness: 0.4,
      roughness: 0.25,
    })
  );
  crystal.position.set(cp.x, 0.55, cp.z);
  crystal.castShadow = true;
  crystal.userData = { type: 'crystal', x: crystalX, z: crystalZ };
  scene.add(crystal);
  crystalMesh = crystal;

  // Soft glow ring
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.5, 0.65, 32),
    new THREE.MeshBasicMaterial({ color: 0xffd266, transparent: true, opacity: 0.35, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(cp.x, 0.16, cp.z);
  boardGroup.add(ring);
}

function makeArcherFigure(color) {
  const bodyMat = new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: 0.12,
    roughness: 0.55,
    metalness: 0.15,
  });
  const skinMat = new THREE.MeshStandardMaterial({
    color: 0xe8c4a2,
    roughness: 0.7,
    metalness: 0.05,
  });
  const darkMat = new THREE.MeshStandardMaterial({
    color: 0x2a1f14,
    roughness: 0.85,
    metalness: 0.1,
  });
  const woodMat = new THREE.MeshStandardMaterial({
    color: 0x6b3f1f,
    roughness: 0.8,
    metalness: 0.05,
  });
  const stringMat = new THREE.MeshStandardMaterial({
    color: 0xd8d0c0,
    roughness: 0.6,
    metalness: 0.05,
  });

  const fig = new THREE.Group();
  fig.name = 'archerFigure';

  // Legs
  const legGeo = new THREE.CylinderGeometry(0.055, 0.065, 0.28, 8);
  const leftLeg = new THREE.Mesh(legGeo, darkMat);
  leftLeg.position.set(-0.07, 0.3, 0);
  leftLeg.castShadow = true;
  const rightLeg = new THREE.Mesh(legGeo, darkMat);
  rightLeg.position.set(0.07, 0.3, 0);
  rightLeg.castShadow = true;

  // Torso / tunic
  const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 0.32, 10), bodyMat);
  torso.position.y = 0.58;
  torso.castShadow = true;

  // Shoulders
  const shoulders = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.08, 0.14), bodyMat);
  shoulders.position.y = 0.74;
  shoulders.castShadow = true;

  // Head
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.095, 12, 10), skinMat);
  head.position.y = 0.9;
  head.castShadow = true;

  // Hood / hair cap
  const hood = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), darkMat);
  hood.position.y = 0.93;
  hood.castShadow = true;

  // Arms
  const armGeo = new THREE.CylinderGeometry(0.04, 0.045, 0.26, 8);
  const leftArm = new THREE.Mesh(armGeo, skinMat);
  leftArm.position.set(-0.18, 0.62, 0.02);
  leftArm.rotation.z = 0.35;
  leftArm.castShadow = true;
  const rightArm = new THREE.Mesh(armGeo, skinMat);
  rightArm.position.set(0.2, 0.64, 0.05);
  rightArm.rotation.z = -0.55;
  rightArm.rotation.x = -0.25;
  rightArm.castShadow = true;

  // Bow (held to the unit's right / +X)
  const bow = new THREE.Group();
  bow.position.set(0.28, 0.62, 0.02);
  const upperLimb = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.018, 6, 12, Math.PI * 0.85), woodMat);
  upperLimb.rotation.y = Math.PI / 2;
  upperLimb.rotation.z = Math.PI / 2;
  upperLimb.castShadow = true;
  const bowGrip = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.1, 6), woodMat);
  bowGrip.castShadow = true;
  const bowString = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.38, 4), stringMat);
  bowString.position.z = 0.18;
  bow.add(upperLimb, bowGrip, bowString);

  // Quiver on back
  const quiver = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.045, 0.28, 8), darkMat);
  quiver.position.set(-0.02, 0.62, -0.14);
  quiver.rotation.x = 0.2;
  quiver.castShadow = true;
  const arrowNock = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.2, 4), woodMat);
  arrowNock.position.set(-0.02, 0.78, -0.14);
  arrowNock.rotation.x = 0.2;

  fig.add(leftLeg, rightLeg, torso, shoulders, head, hood, leftArm, rightArm, bow, quiver, arrowNock);
  return fig;
}

function makeKnightFigure(color) {
  const armorMat = new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: 0.14,
    roughness: 0.28,
    metalness: 0.85,
  });
  const steelMat = new THREE.MeshStandardMaterial({
    color: 0xc0c8d4,
    emissive: 0x222830,
    emissiveIntensity: 0.05,
    roughness: 0.25,
    metalness: 0.9,
  });
  const darkSteel = new THREE.MeshStandardMaterial({
    color: 0x4a5562,
    roughness: 0.35,
    metalness: 0.8,
  });
  const leatherMat = new THREE.MeshStandardMaterial({
    color: 0x3a2418,
    roughness: 0.85,
    metalness: 0.05,
  });

  const fig = new THREE.Group();
  fig.name = 'knightFigure';

  // Armored greaves / legs
  const legGeo = new THREE.CylinderGeometry(0.06, 0.07, 0.3, 8);
  const leftLeg = new THREE.Mesh(legGeo, steelMat);
  leftLeg.position.set(-0.08, 0.31, 0);
  leftLeg.castShadow = true;
  const rightLeg = new THREE.Mesh(legGeo, steelMat);
  rightLeg.position.set(0.08, 0.31, 0);
  rightLeg.castShadow = true;

  // Sabatons (feet)
  const footGeo = new THREE.BoxGeometry(0.1, 0.05, 0.16);
  const leftFoot = new THREE.Mesh(footGeo, darkSteel);
  leftFoot.position.set(-0.08, 0.14, 0.02);
  const rightFoot = new THREE.Mesh(footGeo, darkSteel);
  rightFoot.position.set(0.08, 0.14, 0.02);

  // Breastplate
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.34, 0.18), armorMat);
  torso.position.y = 0.6;
  torso.castShadow = true;

  // Fauld / waist plates
  const waist = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.15, 0.1, 10), darkSteel);
  waist.position.y = 0.42;
  waist.castShadow = true;

  // Pauldrons (shoulder armor)
  const pauldronGeo = new THREE.SphereGeometry(0.09, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.65);
  const leftPauldron = new THREE.Mesh(pauldronGeo, armorMat);
  leftPauldron.position.set(-0.18, 0.74, 0);
  leftPauldron.rotation.z = 0.4;
  leftPauldron.castShadow = true;
  const rightPauldron = new THREE.Mesh(pauldronGeo, armorMat);
  rightPauldron.position.set(0.18, 0.74, 0);
  rightPauldron.rotation.z = -0.4;
  rightPauldron.castShadow = true;

  // Arms / vambraces
  const armGeo = new THREE.CylinderGeometry(0.045, 0.05, 0.26, 8);
  const leftArm = new THREE.Mesh(armGeo, steelMat);
  leftArm.position.set(-0.22, 0.58, 0.02);
  leftArm.rotation.z = 0.25;
  leftArm.castShadow = true;
  const rightArm = new THREE.Mesh(armGeo, steelMat);
  rightArm.position.set(0.24, 0.6, 0.04);
  rightArm.rotation.z = -0.9;
  rightArm.rotation.x = -0.2;
  rightArm.castShadow = true;

  // Helmet (great-helm style)
  const helm = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.11, 0.16, 10), steelMat);
  helm.position.y = 0.9;
  helm.castShadow = true;
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.04, 0.12), darkSteel);
  visor.position.set(0, 0.88, 0.06);
  const crest = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.12, 0.08), armorMat);
  crest.position.set(0, 1.0, 0);

  // Sword in right hand
  const hilt = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.1, 6), leatherMat);
  hilt.position.set(0.34, 0.48, 0.06);
  hilt.rotation.z = -0.9;
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.36, 0.015), steelMat);
  blade.position.set(0.42, 0.34, 0.08);
  blade.rotation.z = -0.9;
  blade.castShadow = true;
  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.025, 0.025), darkSteel);
  guard.position.set(0.36, 0.44, 0.07);
  guard.rotation.z = -0.9;

  // Shield on left arm
  const shield = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.28, 0.22), armorMat);
  shield.position.set(-0.3, 0.55, 0.06);
  shield.rotation.y = 0.35;
  shield.castShadow = true;
  const shieldBoss = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), steelMat);
  shieldBoss.position.set(-0.33, 0.55, 0.08);

  fig.add(
    leftLeg, rightLeg, leftFoot, rightFoot,
    waist, torso, leftPauldron, rightPauldron,
    leftArm, rightArm, helm, visor, crest,
    hilt, blade, guard, shield, shieldBoss
  );
  return fig;
}

function makeArmoredCarriage(color) {
  const armorMat = new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: 0.12,
    roughness: 0.35,
    metalness: 0.75,
  });
  const steelMat = new THREE.MeshStandardMaterial({
    color: 0xa8b0bc,
    roughness: 0.3,
    metalness: 0.85,
  });
  const darkMat = new THREE.MeshStandardMaterial({
    color: 0x2c3038,
    roughness: 0.5,
    metalness: 0.6,
  });
  const woodMat = new THREE.MeshStandardMaterial({
    color: 0x4a3424,
    roughness: 0.85,
    metalness: 0.05,
  });

  const fig = new THREE.Group();
  fig.name = 'armoredCarriage';

  // Chassis / wagon body
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.32, 0.42), armorMat);
  body.position.y = 0.38;
  body.castShadow = true;

  // Armored roof / casemate
  const roof = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.18, 0.36), steelMat);
  roof.position.y = 0.62;
  roof.castShadow = true;

  // Sloped front plate
  const front = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.28, 0.4), darkMat);
  front.position.set(0.36, 0.4, 0);
  front.rotation.z = -0.35;
  front.castShadow = true;

  // Rear plate
  const rear = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.3, 0.38), darkMat);
  rear.position.set(-0.36, 0.4, 0);
  rear.castShadow = true;

  // Side rivet strips
  const stripGeo = new THREE.BoxGeometry(0.55, 0.04, 0.03);
  const leftStrip = new THREE.Mesh(stripGeo, steelMat);
  leftStrip.position.set(0, 0.5, 0.22);
  const rightStrip = new THREE.Mesh(stripGeo, steelMat);
  rightStrip.position.set(0, 0.5, -0.22);

  // Viewing slit
  const slit = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.03, 0.02), darkMat);
  slit.position.set(0.2, 0.64, 0.19);

  // Cannon / prow spike
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.28, 8), darkMat);
  barrel.rotation.z = Math.PI / 2;
  barrel.position.set(0.52, 0.42, 0);
  barrel.castShadow = true;

  // Wheels (4)
  const wheelGeo = new THREE.CylinderGeometry(0.14, 0.14, 0.06, 14);
  const hubGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.07, 8);
  const wheels = [];
  const positions = [
    [0.22, 0.14, 0.26],
    [0.22, 0.14, -0.26],
    [-0.22, 0.14, 0.26],
    [-0.22, 0.14, -0.26],
  ];
  for (const [x, y, z] of positions) {
    const wheel = new THREE.Mesh(wheelGeo, woodMat);
    wheel.rotation.x = Math.PI / 2;
    wheel.position.set(x, y, z);
    wheel.castShadow = true;
    const hub = new THREE.Mesh(hubGeo, steelMat);
    hub.rotation.x = Math.PI / 2;
    hub.position.set(x, y, z);
    wheels.push(wheel, hub);
  }

  // Axles
  const axleGeo = new THREE.CylinderGeometry(0.02, 0.02, 0.55, 6);
  const frontAxle = new THREE.Mesh(axleGeo, darkMat);
  frontAxle.rotation.x = Math.PI / 2;
  frontAxle.position.set(0.22, 0.14, 0);
  const rearAxle = new THREE.Mesh(axleGeo, darkMat);
  rearAxle.rotation.x = Math.PI / 2;
  rearAxle.position.set(-0.22, 0.14, 0);

  // Banner stub on roof (faction color accent)
  const bannerPole = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.22, 6), steelMat);
  bannerPole.position.set(-0.1, 0.82, 0);
  const banner = new THREE.Mesh(new THREE.PlaneGeometry(0.14, 0.1), armorMat);
  banner.position.set(-0.02, 0.86, 0);
  banner.rotation.y = Math.PI / 2;

  fig.add(
    body, roof, front, rear, leftStrip, rightStrip, slit, barrel,
    frontAxle, rearAxle, bannerPole, banner, ...wheels
  );
  return fig;
}

function makeUnitMesh(def, faction) {
  const color = faction === 'player' ? def.colorPlayer : def.colorEnemy;
  let mesh;
  let hpY = 1.05;
  if (def.shape === 'archer' || def.shape === 'cone') {
    mesh = makeArcherFigure(color);
    hpY = 1.2;
  } else if (def.shape === 'knight' || def.shape === 'box') {
    mesh = makeKnightFigure(color);
    hpY = 1.25;
  } else if (def.shape === 'carriage' || def.shape === 'cylinder') {
    mesh = makeArmoredCarriage(color);
    hpY = 1.05;
  } else {
    const mat = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.18,
      roughness: 0.45,
      metalness: 0.25,
    });
    mesh = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.55, 0.48), mat);
    mesh.position.y = 0.4;
    mesh.castShadow = true;
  }

  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.38, 0.4, 0.08, 16),
    new THREE.MeshStandardMaterial({ color: faction === 'player' ? 0x145a70 : 0x703018, roughness: 0.8 })
  );
  base.position.y = 0.12;
  base.castShadow = true;

  const g = new THREE.Group();
  g.add(base, mesh);

  // HP bar
  const barBg = new THREE.Mesh(
    new THREE.PlaneGeometry(0.7, 0.08),
    new THREE.MeshBasicMaterial({ color: 0x111820, transparent: true, opacity: 0.85, depthTest: false })
  );
  barBg.position.set(0, hpY, 0);
  const barFg = new THREE.Mesh(
    new THREE.PlaneGeometry(0.66, 0.05),
    new THREE.MeshBasicMaterial({ color: 0x5dff9a, depthTest: false })
  );
  barFg.position.set(0, hpY, 0.01);
  barFg.name = 'hpBar';
  g.add(barBg, barFg);

  return g;
}

function updateHpBar(unit) {
  const bar = unit.mesh.getObjectByName('hpBar');
  if (!bar) return;
  const ratio = Math.max(0, unit.hp / unit.maxHp);
  bar.scale.x = Math.max(0.01, ratio);
  bar.position.x = -0.33 * (1 - ratio);
  bar.material.color.setHex(ratio > 0.5 ? 0x5dff9a : ratio > 0.25 ? 0xffd266 : 0xff5d7a);
}

function spawnUnits() {
  while (unitsGroup.children.length) unitsGroup.remove(unitsGroup.children[0]);
  units = [];

  // 2× armies (5 → 10 per side) on the enlarged 16×16 board
  const E = GRID - 1;
  const layout = [
    { type: 'bastion', faction: 'player', x: 0, z: 1 },
    { type: 'bastion', faction: 'player', x: 1, z: 0 },
    { type: 'infantry', faction: 'player', x: 0, z: 2 },
    { type: 'infantry', faction: 'player', x: 2, z: 0 },
    { type: 'infantry', faction: 'player', x: 0, z: 3 },
    { type: 'infantry', faction: 'player', x: 3, z: 0 },
    { type: 'archer', faction: 'player', x: 1, z: 1 },
    { type: 'archer', faction: 'player', x: 2, z: 1 },
    { type: 'archer', faction: 'player', x: 1, z: 2 },
    { type: 'archer', faction: 'player', x: 2, z: 2 },

    { type: 'bastion', faction: 'enemy', x: E, z: E - 1 },
    { type: 'bastion', faction: 'enemy', x: E - 1, z: E },
    { type: 'infantry', faction: 'enemy', x: E, z: E - 2 },
    { type: 'infantry', faction: 'enemy', x: E - 2, z: E },
    { type: 'infantry', faction: 'enemy', x: E, z: E - 3 },
    { type: 'infantry', faction: 'enemy', x: E - 3, z: E },
    { type: 'archer', faction: 'enemy', x: E - 1, z: E - 1 },
    { type: 'archer', faction: 'enemy', x: E - 2, z: E - 1 },
    { type: 'archer', faction: 'enemy', x: E - 1, z: E - 2 },
    { type: 'archer', faction: 'enemy', x: E - 2, z: E - 2 },
  ];

  for (const L of layout) {
    const def = UNIT_DEFS[L.type];
    const mesh = makeUnitMesh(def, L.faction);
    const p = worldPos(L.x, L.z);
    mesh.position.set(p.x, 0, p.z);
    mesh.userData = { type: 'unit' };
    unitsGroup.add(mesh);
    const u = {
      id: `${L.faction}-${L.type}-${L.x}-${L.z}-${Math.random().toString(36).slice(2, 6)}`,
      type: L.type,
      faction: L.faction,
      x: L.x,
      z: L.z,
      hp: def.hp,
      maxHp: def.hp,
      moved: false,
      attacked: false,
      mesh,
      def,
    };
    mesh.userData.unitId = u.id;
    units.push(u);
    updateHpBar(u);
  }
}

function unitAt(x, z) {
  return units.find((u) => u.hp > 0 && u.x === x && u.z === z);
}

function tileAt(x, z) {
  return tiles.find((t) => t.x === x && t.z === z);
}

function inBounds(x, z) {
  return x >= 0 && z >= 0 && x < GRID && z < GRID;
}

function manhattan(a, b, c, d) {
  return Math.abs(a - c) + Math.abs(b - d);
}

function bfsReachable(sx, sz, movePts, ignoreUnit = null) {
  const dist = new Map();
  const q = [[sx, sz, 0]];
  dist.set(key(sx, sz), 0);
  const out = new Set();
  while (q.length) {
    const [x, z, d] = q.shift();
    if (d > 0) out.add(key(x, z));
    if (d >= movePts) continue;
    for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = x + dx, nz = z + dz;
      if (!inBounds(nx, nz)) continue;
      const t = tileAt(nx, nz);
      if (!t || t.obstacle) continue;
      const occ = unitAt(nx, nz);
      if (occ && occ !== ignoreUnit) continue;
      const nk = key(nx, nz);
      const nd = d + 1;
      if (!dist.has(nk) || dist.get(nk) > nd) {
        dist.set(nk, nd);
        q.push([nx, nz, nd]);
      }
    }
  }
  return out;
}

function getAttackTargets(unit) {
  const set = new Set();
  for (const e of units) {
    if (e.hp <= 0 || e.faction === unit.faction) continue;
    const d = manhattan(unit.x, unit.z, e.x, e.z);
    if (d >= unit.def.minRange && d <= unit.def.range) set.add(key(e.x, e.z));
  }
  return set;
}

function clearHighlights() {
  while (highlightGroup.children.length) {
    const c = highlightGroup.children[0];
    highlightGroup.remove(c);
    if (c.geometry) c.geometry.dispose();
    if (c.material) c.material.dispose();
  }
  reachable.clear();
  attackable.clear();
}

function addHighlight(x, z, color, opacity = 0.45) {
  const p = worldPos(x, z);
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(TILE * 0.88, TILE * 0.88),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false })
  );
  m.rotation.x = -Math.PI / 2;
  m.position.set(p.x, 0.16, p.z);
  highlightGroup.add(m);
}

function refreshSelectionVisuals() {
  clearHighlights();
  if (!selected || selected.hp <= 0 || phase !== 'player') return;

  if (!selected.moved) {
    reachable = bfsReachable(selected.x, selected.z, selected.def.move, selected);
    for (const k of reachable) {
      const [x, z] = k.split(',').map(Number);
      addHighlight(x, z, 0x3ad7ff, 0.4);
    }
  }

  if (!selected.attacked) {
    // Show attack from current position (after move, unit is already there)
    attackable = getAttackTargets(selected);
    for (const k of attackable) {
      const [x, z] = k.split(',').map(Number);
      addHighlight(x, z, 0xff5d7a, 0.5);
    }
  }

  // Selected tile ring
  addHighlight(selected.x, selected.z, 0xffd266, 0.35);
}

function updateUnitInfo() {
  if (!selected || selected.hp <= 0) {
    ui.unitInfo.innerHTML = phase === 'player'
      ? 'Tap a <strong>cyan</strong> unit to select, then tap a highlighted tile to move or attack.'
      : 'Ember AI is thinking…';
    return;
  }
  const canMove = !selected.moved ? `Move ${selected.def.move}` : 'Moved';
  const canAtk = !selected.attacked ? `Atk ${selected.def.atk} (rng ${selected.def.minRange}–${selected.def.range})` : 'Attacked';
  ui.unitInfo.innerHTML = `<strong>${selected.def.name}</strong> · HP ${selected.hp}/${selected.maxHp}<br>${canMove} · ${canAtk}`;
}

function updateHudCounts() {
  const pc = units.filter((u) => u.faction === 'player' && u.hp > 0).length;
  const ec = units.filter((u) => u.faction === 'enemy' && u.hp > 0).length;
  ui.playerCount.textContent = String(pc);
  ui.enemyCount.textContent = String(ec);
  ui.turnNum.textContent = String(turn);
}

function selectUnit(unit) {
  if (phase !== 'player' || !gameActive) return;
  if (!unit || unit.faction !== 'player' || unit.hp <= 0) return;
  selected = unit;
  refreshSelectionVisuals();
  updateUnitInfo();
}

function faceBarsToCamera() {
  for (const u of units) {
    if (u.hp <= 0) continue;
    u.mesh.children.forEach((ch) => {
      if (ch.isMesh && ch.geometry && ch.geometry.type === 'PlaneGeometry') {
        ch.quaternion.copy(camera.quaternion);
      }
    });
  }
}

function animateCrystal() {
  if (crystalMesh) {
    crystalMesh.rotation.y += 0.015;
    crystalMesh.position.y = 0.55 + Math.sin(performance.now() * 0.003) * 0.08;
  }
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  faceBarsToCamera();
  animateCrystal();
  renderer.render(scene, camera);
}

function screenToNDC(e) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
}

let pointerDownAt = null;
let pointerMoved = false;

function onPointerDown(e) {
  if (!gameActive || phase !== 'player') return;
  pointerDownAt = { x: e.clientX, y: e.clientY, t: Date.now() };
  pointerMoved = false;
  const up = (ev) => {
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointermove', move);
    if (!pointerDownAt) return;
    const dx = ev.clientX - pointerDownAt.x;
    const dy = ev.clientY - pointerDownAt.y;
    const dt = Date.now() - pointerDownAt.t;
    pointerDownAt = null;
    if (pointerMoved || Math.hypot(dx, dy) > 12 || dt > 500) return; // treat as orbit
    handleTap(ev);
  };
  const move = (ev) => {
    if (!pointerDownAt) return;
    if (Math.hypot(ev.clientX - pointerDownAt.x, ev.clientY - pointerDownAt.y) > 12) pointerMoved = true;
  };
  window.addEventListener('pointerup', up);
  window.addEventListener('pointermove', move);
}

function handleTap(e) {
  screenToNDC(e);
  raycaster.setFromCamera(pointer, camera);

  // Units first
  const unitMeshes = units.filter((u) => u.hp > 0).map((u) => u.mesh);
  const uHits = raycaster.intersectObjects(unitMeshes, true);
  if (uHits.length) {
    let obj = uHits[0].object;
    while (obj && !obj.userData.unitId) obj = obj.parent;
    if (obj && obj.userData.unitId) {
      const unit = units.find((u) => u.id === obj.userData.unitId);
      if (unit) {
        if (unit.faction === 'player') {
          selectUnit(unit);
          return;
        }
        if (selected && attackable.has(key(unit.x, unit.z))) {
          doAttack(selected, unit);
          return;
        }
      }
    }
  }

  // Crystal capture
  if (crystalMesh) {
    const cHits = raycaster.intersectObject(crystalMesh, true);
    if (cHits.length && selected && !selected.moved) {
      const cx = crystalMesh.userData.x;
      const cz = crystalMesh.userData.z;
      if (reachable.has(key(cx, cz)) && !unitAt(cx, cz)) {
        doMove(selected, cx, cz);
        checkCrystalCapture(selected);
        return;
      }
    }
  }

  // Tiles
  const tileMeshes = tiles.map((t) => t.mesh);
  const tHits = raycaster.intersectObjects(tileMeshes, false);
  if (tHits.length) {
    const { x, z } = tHits[0].object.userData;
    const enemy = unitAt(x, z);
    if (enemy && selected && attackable.has(key(x, z))) {
      doAttack(selected, enemy);
      return;
    }
    if (selected && !selected.moved && reachable.has(key(x, z)) && !unitAt(x, z)) {
      doMove(selected, x, z);
      checkCrystalCapture(selected);
      return;
    }
    // Tap empty / own tile to deselect or select
    const own = unitAt(x, z);
    if (own && own.faction === 'player') selectUnit(own);
  }
}

function doMove(unit, x, z) {
  unit.x = x;
  unit.z = z;
  unit.moved = true;
  const p = worldPos(x, z);
  unit.mesh.position.set(p.x, 0, p.z);
  refreshSelectionVisuals();
  updateUnitInfo();
  toast(`${unit.def.name} moved`);
}

function doAttack(attacker, defender) {
  if (attacker.attacked) return;
  const dmg = attacker.def.atk + Math.floor(Math.random() * 2); // 0–1 variance
  defender.hp -= dmg;
  attacker.attacked = true;
  attacker.moved = true; // committing attack ends movement
  updateHpBar(defender);
  toast(`${attacker.def.name} hits for ${dmg}`);

  // Flash
  pulseMesh(defender.mesh);

  if (defender.hp <= 0) {
    defender.hp = 0;
    unitsGroup.remove(defender.mesh);
    toast(`${defender.def.name} destroyed!`, 1400);
  }

  refreshSelectionVisuals();
  updateUnitInfo();
  updateHudCounts();
  checkWinLose();
}

function pulseMesh(mesh) {
  const mats = [];
  mesh.traverse((c) => {
    if (c.isMesh && c.material && c.material.emissive) mats.push(c.material);
  });
  mats.forEach((m) => { m.emissiveIntensity = 0.9; });
  setTimeout(() => mats.forEach((m) => { m.emissiveIntensity = 0.18; }), 200);
}

function checkCrystalCapture(unit) {
  if (!crystalMesh || unit.faction !== 'player') return;
  const cx = crystalMesh.userData.x;
  const cz = crystalMesh.userData.z;
  if (unit.x === cx && unit.z === cz) {
    endGame(true, 'You seized the gold crystal. Gridfall is yours!');
  }
}

function checkWinLose() {
  const pc = units.filter((u) => u.faction === 'player' && u.hp > 0).length;
  const ec = units.filter((u) => u.faction === 'enemy' && u.hp > 0).length;
  if (ec === 0) endGame(true, 'All Ember forces defeated.');
  else if (pc === 0) endGame(false, 'Your army has fallen.');
}

function endGame(win, msg) {
  phase = 'ended';
  gameActive = false;
  selected = null;
  clearHighlights();
  ui.btnEnd.disabled = true;
  ui.endTitle.textContent = win ? 'Victory' : 'Defeat';
  ui.endTitle.style.color = win ? 'var(--gold)' : 'var(--danger)';
  ui.endMsg.textContent = msg;
  setTimeout(() => showOverlay(ui.end), 400);
}

function resetUnitActions(faction) {
  for (const u of units) {
    if (u.faction === faction && u.hp > 0) {
      u.moved = false;
      u.attacked = false;
    }
  }
}

async function endPlayerTurn() {
  if (!gameActive || phase !== 'player') return;
  selected = null;
  clearHighlights();
  updateUnitInfo();
  phase = 'ai';
  ui.phase.textContent = 'Ember turn…';
  ui.phase.classList.remove('player');
  ui.phase.classList.add('enemy');
  ui.btnEnd.disabled = true;
  toast('Ember AI moving…', 1200);
  await sleep(500);
  await runAI();
  if (phase === 'ended') return;
  turn += 1;
  phase = 'player';
  resetUnitActions('player');
  ui.phase.textContent = 'Your turn';
  ui.phase.classList.add('player');
  ui.phase.classList.remove('enemy');
  ui.btnEnd.disabled = false;
  updateHudCounts();
  updateUnitInfo();
  toast('Your turn', 1000);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runAI() {
  resetUnitActions('enemy');
  const enemies = units.filter((u) => u.faction === 'enemy' && u.hp > 0);
  // Sort: prefer bastions last, archers that can shoot first-ish
  enemies.sort((a, b) => a.def.range - b.def.range);

  for (const unit of enemies) {
    if (phase === 'ended') return;
    await sleep(280);
    aiAct(unit);
    updateHudCounts();
    if (checkWinLoseEarly()) return;
  }

  // AI crystal capture check
  if (crystalMesh) {
    const cx = crystalMesh.userData.x;
    const cz = crystalMesh.userData.z;
    for (const u of units) {
      if (u.faction === 'enemy' && u.hp > 0 && u.x === cx && u.z === cz) {
        endGame(false, 'Ember captured the crystal.');
        return;
      }
    }
  }
}

function checkWinLoseEarly() {
  const pc = units.filter((u) => u.faction === 'player' && u.hp > 0).length;
  const ec = units.filter((u) => u.faction === 'enemy' && u.hp > 0).length;
  if (ec === 0) { endGame(true, 'All Ember forces defeated.'); return true; }
  if (pc === 0) { endGame(false, 'Your army has fallen.'); return true; }
  return false;
}

function aiAct(unit) {
  // Try attack in place first
  let targets = [...getAttackTargets(unit)].map((k) => {
    const [x, z] = k.split(',').map(Number);
    return unitAt(x, z);
  }).filter(Boolean);

  if (targets.length) {
    targets.sort((a, b) => a.hp - b.hp);
    doAttackAI(unit, targets[0]);
    return;
  }

  // Move toward nearest player or crystal
  const players = units.filter((u) => u.faction === 'player' && u.hp > 0);
  let goalX = 4, goalZ = 4;
  if (players.length) {
    let best = null, bestD = Infinity;
    for (const p of players) {
      const d = manhattan(unit.x, unit.z, p.x, p.z);
      if (d < bestD) { bestD = d; best = p; }
    }
    if (best) { goalX = best.x; goalZ = best.z; }
  }

  const reach = bfsReachable(unit.x, unit.z, unit.def.move, unit);
  let bestPos = null;
  let bestScore = Infinity;

  // Prefer tiles that enable attack next
  for (const k of reach) {
    const [x, z] = k.split(',').map(Number);
    // Simulate position
    const ox = unit.x, oz = unit.z;
    unit.x = x; unit.z = z;
    const canHit = getAttackTargets(unit).size > 0;
    unit.x = ox; unit.z = oz;
    const distGoal = manhattan(x, z, goalX, goalZ);
    const score = (canHit ? -100 : 0) + distGoal;
    if (score < bestScore) {
      bestScore = score;
      bestPos = { x, z, canHit };
    }
  }

  if (bestPos) {
    unit.x = bestPos.x;
    unit.z = bestPos.z;
    unit.moved = true;
    const p = worldPos(bestPos.x, bestPos.z);
    unit.mesh.position.set(p.x, 0, p.z);

    targets = [...getAttackTargets(unit)].map((k) => {
      const [x, z] = k.split(',').map(Number);
      return unitAt(x, z);
    }).filter(Boolean);
    if (targets.length) {
      targets.sort((a, b) => a.hp - b.hp);
      doAttackAI(unit, targets[0]);
    }
  }
}

function doAttackAI(attacker, defender) {
  const dmg = attacker.def.atk + Math.floor(Math.random() * 2);
  defender.hp -= dmg;
  attacker.attacked = true;
  attacker.moved = true;
  updateHpBar(defender);
  pulseMesh(defender.mesh);
  toast(`Ember ${attacker.def.name} hits for ${dmg}`, 900);
  if (defender.hp <= 0) {
    defender.hp = 0;
    unitsGroup.remove(defender.mesh);
  }
}

function startGame() {
  showOverlay(null);
  setHudVisible(true);
  buildBoard();
  spawnUnits();
  selected = null;
  clearHighlights();
  turn = 1;
  phase = 'player';
  gameActive = true;
  ui.btnEnd.disabled = false;
  ui.phase.textContent = 'Your turn';
  ui.phase.classList.add('player');
  ui.phase.classList.remove('enemy');
  updateHudCounts();
  updateUnitInfo();
  controls.target.set(0, 0.3, 0);
  camera.position.set(18, 26, 22);
  controls.update();
  toast('Battle start — tap a cyan unit', 1800);
}

function goTitle() {
  gameActive = false;
  phase = 'ended';
  selected = null;
  clearHighlights();
  setHudVisible(false);
  showOverlay(ui.title);
}

// UI wiring
$('btn-play').addEventListener('click', startGame);
$('btn-howto').addEventListener('click', () => showOverlay(ui.howto));
$('btn-howto-back').addEventListener('click', () => showOverlay(ui.title));
$('btn-howto-play').addEventListener('click', startGame);
$('btn-again').addEventListener('click', startGame);
$('btn-end-title').addEventListener('click', goTitle);
$('btn-menu').addEventListener('click', goTitle);
ui.btnEnd.addEventListener('click', () => endPlayerTurn());

// Boot
initThree();
buildBoard(); // decorative board on title
spawnUnits();
setHudVisible(false);
showOverlay(ui.title);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
