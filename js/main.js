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
  archer:   { name: 'Archer',   move: 2, hp: 7,  atk: 3, range: 1, minRange: 1, losRange: 3, colorPlayer: 0x7dffb0, colorEnemy: 0xffaa66, shape: 'archer' },
  bastion:  { name: 'Bastion',  move: 2, hp: 16, atk: 5, range: 1, minRange: 1, colorPlayer: 0x8ab4ff, colorEnemy: 0xff5577, shape: 'carriage' },
};

const ARMY_COLORS = {
  player:  { main: 0x3ad7ff, base: 0x145a70, name: 'Cyan' },
  ember:   { main: 0xff7a3a, base: 0x703018, name: 'Ember' },
  ash:     { main: 0xc084fc, base: 0x4a1868, name: 'Ash' },
  cinder:  { main: 0xff5577, base: 0x701828, name: 'Cinder' },
};

function isPlayer(u) { return u.faction === 'player'; }
function isEnemy(u) { return u.faction !== 'player'; }

const $ = (id) => document.getElementById(id);

const BUILD_ID = 'gridfall-v12';

const ui = {
  title: $('title-screen'),
  howto: $('howto-screen'),
  end: $('end-screen'),
  hud: $('hud'),
  bottom: $('bottom-hud'),
  hint: $('camera-hint'),
  toast: $('status-toast'),
  buildBanner: $('build-banner'),
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
let boardGroup, highlightGroup, unitsGroup;
let tiles = []; // {x,z,mesh,obstacle}
let units = [];
let selected = null;
let reachable = new Set();
let attackable = new Set();
let turn = 1;
let phase = 'player'; // player | ai | ended
let gameActive = false;
let toastTimer = null;
let unitInfoHitTimer = null;
/** Defender → active float element (replace, don't stack). */
const activeDmgFloats = new Map();
/** Per-faction set of unit ids that faction has discovered (Chebyshev ≤ 1 contact). */
let factionIntel = { player: new Set(), ember: new Set(), ash: new Set(), cinder: new Set() };
/** Last-known contact memory (no live tracking for movement goals). */
let factionMemory = {
  player: new Map(),
  ember: new Map(),
  ash: new Map(),
  cinder: new Map(),
};
/** Shared blind-scout waypoint rolled once per faction per AI phase. */
let factionScoutGoal = { player: null, ember: null, ash: null, cinder: null };

const CONTACT_RANGE = 1;
const MEMORY_TTL_TURNS = 5;
const CENTER = { x: 7, z: 7 };
const BLIND_JITTER = 1;
const ATTACK_BONUS = -100;
const GOAL_NOISE = 0.3;
const SOFT_CAP_HUNTERS = 3;
const SPAWN_LANDMARKS = {
  player: { x: 2, z: 2 },
  ember: { x: 13, z: 2 },
  ash: { x: 2, z: 13 },
  cinder: { x: 13, z: 13 },
};
const SPAWN_CORNERS = {
  player: [0, 0],
  ember: [GRID - 1, 0],
  ash: [0, GRID - 1],
  cinder: [GRID - 1, GRID - 1],
};
const HEIGHT_MIN = 0;
const HEIGHT_MAX = 0.55; // visual elevation span
const HEIGHT_STEP_MAX = (HEIGHT_MAX - HEIGHT_MIN) * 0.02; // ≤2% of full range per adjoining tile
const DIRS8 = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];

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
  camera.position.set(-20, 24, -20); // SW — cyan army closest to camera

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
  controls.enablePan = true;
  controls.screenSpacePanning = true; // slide board in view X/Y with two fingers
  controls.panSpeed = 1.1;
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
  canvas.style.touchAction = 'none';
  canvas.addEventListener('pointerdown', onPointerDown, { capture: true });

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

function chebyshev(x1, z1, x2, z2) {
  return Math.max(Math.abs(x1 - x2), Math.abs(z1 - z2));
}

function tileHeight(x, z) {
  const t = tileAt(x, z);
  return t ? t.height : 0;
}

function unitWorldY(x, z) {
  return tileHeight(x, z) + 0.12;
}

/** Generate smooth heightmap; neighbor delta ≤ HEIGHT_STEP_MAX. */
function generateHeights(rand) {
  const h = Array.from({ length: GRID }, () => Array(GRID).fill(0));
  // Seed corners / mid with mild noise then diffuse
  for (let z = 0; z < GRID; z++) {
    for (let x = 0; x < GRID; x++) {
      h[z][x] = HEIGHT_MIN + rand() * (HEIGHT_MAX - HEIGHT_MIN);
    }
  }
  for (let pass = 0; pass < 8; pass++) {
    const n = h.map((row) => row.slice());
    for (let z = 0; z < GRID; z++) {
      for (let x = 0; x < GRID; x++) {
        let s = h[z][x], c = 1;
        for (const [dx, dz] of DIRS8) {
          const nx = x + dx, nz = z + dz;
          if (!inBounds(nx, nz)) continue;
          s += h[nz][nx];
          c++;
        }
        n[z][x] = s / c;
      }
    }
    for (let z = 0; z < GRID; z++) for (let x = 0; x < GRID; x++) h[z][x] = n[z][x];
  }
  // Enforce 2% max step between neighbors (relax toward mean)
  for (let iter = 0; iter < 40; iter++) {
    let changed = false;
    for (let z = 0; z < GRID; z++) {
      for (let x = 0; x < GRID; x++) {
        for (const [dx, dz] of [[1,0],[0,1]]) {
          const nx = x + dx, nz = z + dz;
          if (!inBounds(nx, nz)) continue;
          const d = h[nz][nx] - h[z][x];
          if (Math.abs(d) > HEIGHT_STEP_MAX) {
            const mid = (h[z][x] + h[nz][nx]) / 2;
            const half = HEIGHT_STEP_MAX / 2;
            if (d > 0) { h[z][x] = mid - half; h[nz][nx] = mid + half; }
            else { h[z][x] = mid + half; h[nz][nx] = mid - half; }
            changed = true;
          }
        }
      }
    }
    if (!changed) break;
  }
  // Normalize into [HEIGHT_MIN, HEIGHT_MAX] while preserving relative diffs roughly
  let mn = Infinity, mx = -Infinity;
  for (let z = 0; z < GRID; z++) for (let x = 0; x < GRID; x++) {
    mn = Math.min(mn, h[z][x]); mx = Math.max(mx, h[z][x]);
  }
  const span = Math.max(1e-6, mx - mn);
  for (let z = 0; z < GRID; z++) for (let x = 0; x < GRID; x++) {
    h[z][x] = HEIGHT_MIN + ((h[z][x] - mn) / span) * (HEIGHT_MAX - HEIGHT_MIN);
  }
  // Re-clamp steps after normalize
  for (let iter = 0; iter < 20; iter++) {
    let changed = false;
    for (let z = 0; z < GRID; z++) {
      for (let x = 0; x < GRID; x++) {
        for (const [dx, dz] of [[1,0],[0,1]]) {
          const nx = x + dx, nz = z + dz;
          if (!inBounds(nx, nz)) continue;
          const d = h[nz][nx] - h[z][x];
          if (Math.abs(d) > HEIGHT_STEP_MAX) {
            const mid = (h[z][x] + h[nz][nx]) / 2;
            const half = HEIGHT_STEP_MAX / 2;
            if (d > 0) { h[z][x] = mid - half; h[nz][nx] = mid + half; }
            else { h[z][x] = mid + half; h[nz][nx] = mid - half; }
            changed = true;
          }
        }
      }
    }
    if (!changed) break;
  }
  return h;
}

function countAdjacentAllies(unit) {
  let n = 0;
  for (const o of units) {
    if (o === unit || o.hp <= 0 || o.faction !== unit.faction) continue;
    if (chebyshev(unit.x, unit.z, o.x, o.z) === 1) n++;
  }
  return n;
}

/** Attacker damage multiplier: height +2%, cluster +4%/+8%. */
function attackMultiplier(attacker, defender) {
  let m = 1;
  const notes = [];
  if (tileHeight(attacker.x, attacker.z) > tileHeight(defender.x, defender.z)) {
    m *= 1.02;
    notes.push('high ground +2%');
  }
  const allies = countAdjacentAllies(attacker);
  if (allies >= 2) { m *= 1.08; notes.push('formed 3+ +8%'); }
  else if (allies >= 1) { m *= 1.04; notes.push('paired +4%'); }
  return { mult: m, notes };
}

function losClear(x0, z0, x1, z1, faction) {
  // Bresenham through intermediate tiles; blockers: obstacles or enemy units
  let x = x0, z = z0;
  const dx = Math.abs(x1 - x0), dz = Math.abs(z1 - z0);
  const sx = x0 < x1 ? 1 : -1;
  const sz = z0 < z1 ? 1 : -1;
  let err = dx - dz;
  while (true) {
    if (!(x === x0 && z === z0) && !(x === x1 && z === z1)) {
      const t = tileAt(x, z);
      if (!t || t.obstacle) return false;
      const u = unitAt(x, z);
      if (u && u.faction !== faction) return false;
      // friendly or empty OK
    }
    if (x === x1 && z === z1) break;
    const e2 = 2 * err;
    if (e2 > -dz) { err -= dz; x += sx; }
    if (e2 < dx) { err += dx; z += sz; }
  }
  return true;
}

function emptyFactionMaps() {
  return {
    player: new Map(),
    ember: new Map(),
    ash: new Map(),
    cinder: new Map(),
  };
}

function resetIntel() {
  factionIntel = { player: new Set(), ember: new Set(), ash: new Set(), cinder: new Set() };
  factionMemory = emptyFactionMaps();
  factionScoutGoal = { player: null, ember: null, ash: null, cinder: null };
  // Own units always known to self
  for (const u of units) {
    if (u.hp <= 0) continue;
    if (!factionIntel[u.faction]) factionIntel[u.faction] = new Set();
    factionIntel[u.faction].add(u.id);
  }
  updateIntelFromContact();
}

function updateIntelFromContact() {
  const live = units.filter((u) => u.hp > 0);
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i], b = live[j];
      if (a.faction === b.faction) continue;
      if (chebyshev(a.x, a.z, b.x, b.z) <= CONTACT_RANGE) {
        if (!factionIntel[a.faction]) factionIntel[a.faction] = new Set();
        if (!factionIntel[b.faction]) factionIntel[b.faction] = new Set();
        factionIntel[a.faction].add(b.id);
        factionIntel[b.faction].add(a.id);
        if (!factionMemory[a.faction]) factionMemory[a.faction] = new Map();
        if (!factionMemory[b.faction]) factionMemory[b.faction] = new Map();
        factionMemory[a.faction].set(b.id, { id: b.id, x: b.x, z: b.z, turn, aliveGuess: true });
        factionMemory[b.faction].set(a.id, { id: a.id, x: a.x, z: a.z, turn, aliveGuess: true });
      }
    }
  }
}

/** Live known enemies — do NOT use for movement goals (last-known memory only). */
function knownEnemies(faction) {
  const known = factionIntel[faction] || new Set();
  return units.filter((u) => u.hp > 0 && u.faction !== faction && known.has(u.id));
}

function pruneFactionMemory(faction) {
  const mem = factionMemory[faction];
  if (!mem) return;
  for (const [id, entry] of [...mem.entries()]) {
    const u = units.find((x) => x.id === id);
    if (!u || u.hp <= 0) {
      mem.delete(id);
      continue;
    }
    if (turn - entry.turn > MEMORY_TTL_TURNS) mem.delete(id);
  }
}

function knownContacts(faction) {
  const mem = factionMemory[faction];
  if (!mem) return [];
  const out = [];
  for (const entry of mem.values()) {
    const u = units.find((x) => x.id === entry.id);
    if (u && u.hp > 0) out.push(entry);
  }
  return out;
}

function pickSoftExploreTile(faction) {
  const own = SPAWN_CORNERS[faction] || [0, 0];
  const mid = Math.floor(GRID / 2);
  const wantHighX = own[0] < mid;
  const wantHighZ = own[1] < mid;
  for (let t = 0; t < 40; t++) {
    const x = wantHighX
      ? mid + Math.floor(Math.random() * (GRID - mid))
      : Math.floor(Math.random() * mid);
    const z = wantHighZ
      ? mid + Math.floor(Math.random() * (GRID - mid))
      : Math.floor(Math.random() * mid);
    const tile = tileAt(x, z);
    if (tile && !tile.obstacle) return { x, z };
  }
  return { x: CENTER.x, z: CENTER.z };
}

function applyBlindJitter(lx, lz) {
  for (let t = 0; t < 5; t++) {
    const ox = Math.floor(Math.random() * (BLIND_JITTER * 2 + 1)) - BLIND_JITTER;
    const oz = Math.floor(Math.random() * (BLIND_JITTER * 2 + 1)) - BLIND_JITTER;
    const x = Math.max(0, Math.min(GRID - 1, lx + ox));
    const z = Math.max(0, Math.min(GRID - 1, lz + oz));
    const tile = tileAt(x, z);
    if (tile && !tile.obstacle) return { x, z };
  }
  return { x: lx, z: lz };
}

function rollFactionScoutGoal(faction) {
  const r = Math.random();
  let landmark;
  if (r < 0.35) {
    landmark = { x: CENTER.x, z: CENTER.z };
  } else if (r < 0.35 + 0.55) {
    const enemies = ['player', 'ember', 'ash', 'cinder'].filter((f) => f !== faction);
    const pick = enemies[Math.floor(Math.random() * enemies.length)];
    landmark = { ...(SPAWN_LANDMARKS[pick] || CENTER) };
  } else {
    landmark = pickSoftExploreTile(faction);
  }
  const jittered = applyBlindJitter(landmark.x, landmark.z);
  return { x: jittered.x, z: jittered.z, turn };
}

/**
 * Soft-cap hunt goal (§7): among contacts sorted for this unit, use the first
 * contact for which this unit is among the SOFT_CAP_HUNTERS closest allies.
 */
function contactGoalForUnit(faction, unit, contacts) {
  if (!contacts.length) return null;
  const sorted = [...contacts].sort((a, b) => {
    const da = chebyshev(unit.x, unit.z, a.x, a.z);
    const db = chebyshev(unit.x, unit.z, b.x, b.z);
    if (da !== db) return da - db;
    if (b.turn !== a.turn) return b.turn - a.turn;
    return String(a.id).localeCompare(String(b.id));
  });
  const allies = units.filter((u) => u.faction === faction && u.hp > 0);
  for (const c of sorted) {
    const ranked = [...allies].sort((a, b) => {
      const da = chebyshev(a.x, a.z, c.x, c.z);
      const db = chebyshev(b.x, b.z, c.x, c.z);
      if (da !== db) return da - db;
      return String(a.id).localeCompare(String(b.id));
    });
    const idx = ranked.findIndex((u) => u.id === unit.id);
    if (idx >= 0 && idx < SOFT_CAP_HUNTERS) {
      return { x: c.x, z: c.z, contactId: c.id };
    }
  }
  return null;
}

function attackTargetsFromMemory(unit) {
  const mem = factionMemory[unit.faction];
  if (!mem || mem.size === 0) return [];
  return [...getAttackTargets(unit)].map((k) => {
    const [x, z] = k.split(',').map(Number);
    return unitAt(x, z);
  }).filter((t) => t && mem.has(t.id));
}


function buildBoard() {
  while (boardGroup.children.length) boardGroup.remove(boardGroup.children[0]);
  tiles = [];

  // 20 rocks; keep all four spawn corners clear (no center objective)
  const obstacles = new Set();
  const banned = new Set();
  for (let z = 0; z < 5; z++) for (let x = 0; x < 5; x++) banned.add(key(x, z));
  for (let z = 0; z < 5; z++) for (let x = GRID - 5; x < GRID; x++) banned.add(key(x, z));
  for (let z = GRID - 5; z < GRID; z++) for (let x = 0; x < 5; x++) banned.add(key(x, z));
  for (let z = GRID - 5; z < GRID; z++) for (let x = GRID - 5; x < GRID; x++) banned.add(key(x, z));
  const candidates = [];
  for (let z = 0; z < GRID; z++) {
    for (let x = 0; x < GRID; x++) {
      if (!banned.has(key(x, z))) candidates.push([x, z]);
    }
  }
  let seed = 42;
  const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  for (let i = 0; i < 20 && i < candidates.length; i++) {
    obstacles.add(key(candidates[i][0], candidates[i][1]));
  }

  const heights = generateHeights(rand);

  for (let z = 0; z < GRID; z++) {
    for (let x = 0; x < GRID; x++) {
      const isObs = obstacles.has(key(x, z));
      const height = heights[z][x];
      const tHigh = (height - HEIGHT_MIN) / Math.max(1e-6, HEIGHT_MAX - HEIGHT_MIN);
      // Seamless tiles (no visible gaps/lines): full TILE footprint, slight overlap
      const geo = new THREE.BoxGeometry(TILE * 1.02, 0.18 + height, TILE * 1.02);
      const lowCol = new THREE.Color(0x16304f);
      const highCol = new THREE.Color(0x3a6a4a);
      const col = lowCol.clone().lerp(highCol, tHigh);
      if (isObs) col.setHex(0x3a4558);
      const mat = new THREE.MeshStandardMaterial({
        color: col,
        roughness: 0.78,
        metalness: 0.08,
      });
      const mesh = new THREE.Mesh(geo, mat);
      const p = worldPos(x, z);
      const topY = (0.18 + height) / 2;
      mesh.position.set(p.x, topY, p.z);
      mesh.receiveShadow = true;
      mesh.castShadow = true;
      mesh.userData = { type: 'tile', x, z };
      boardGroup.add(mesh);

      if (isObs) {
        const rock = new THREE.Mesh(
          new THREE.DodecahedronGeometry(0.35, 0),
          new THREE.MeshStandardMaterial({ color: 0x6a7388, roughness: 0.9 })
        );
        rock.position.set(p.x, height + 0.45, p.z);
        rock.castShadow = true;
        boardGroup.add(rock);
      }
      tiles.push({ x, z, mesh, obstacle: isObs, height });
    }
  }
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
  const army = ARMY_COLORS[faction] || ARMY_COLORS.ember;
  const color = army.main;
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
    new THREE.MeshStandardMaterial({ color: army.base, roughness: 0.8 })
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

  // Four armies — one per corner (you = Cyan / SW). Each: 10 units (1 bastion, 5 infantry, 4 archers).
  const E = GRID - 1;
  const armyPattern = (faction, ox, oz, flipX, flipZ) => {
    const fx = (x) => (flipX ? ox - x : ox + x);
    const fz = (z) => (flipZ ? oz - z : oz + z);
    return [
      { type: 'bastion', faction, x: fx(0), z: fz(1) },
      { type: 'infantry', faction, x: fx(1), z: fz(0) },
      { type: 'infantry', faction, x: fx(0), z: fz(2) },
      { type: 'infantry', faction, x: fx(2), z: fz(1) },
      { type: 'infantry', faction, x: fx(1), z: fz(2) },
      { type: 'infantry', faction, x: fx(3), z: fz(0) },
      { type: 'archer', faction, x: fx(2), z: fz(0) },
      { type: 'archer', faction, x: fx(0), z: fz(3) },
      { type: 'archer', faction, x: fx(3), z: fz(1) },
      { type: 'archer', faction, x: fx(1), z: fz(1) },
    ];
  };
  const layout = [
    ...armyPattern('player', 0, 0, false, false),       // SW
    ...armyPattern('ember', E, 0, true, false),         // SE
    ...armyPattern('ash', 0, E, false, true),           // NW
    ...armyPattern('cinder', E, E, true, true),         // NE
  ];

  for (const L of layout) {
    const def = UNIT_DEFS[L.type];
    const mesh = makeUnitMesh(def, L.faction);
    const p = worldPos(L.x, L.z);
    mesh.position.set(p.x, unitWorldY(L.x, L.z), p.z);
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
  resetIntel();
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
    for (const [dx, dz] of DIRS8) {
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
    const d = chebyshev(unit.x, unit.z, e.x, e.z);
    if (unit.type === 'archer') {
      const maxR = unit.def.losRange || 3;
      if (d <= 1) set.add(key(e.x, e.z));
      else if (d <= maxR && losClear(unit.x, unit.z, e.x, e.z, unit.faction)) set.add(key(e.x, e.z));
    } else {
      // Melee: any adjacent tile including diagonals
      if (d >= (unit.def.minRange || 1) && d <= (unit.def.range || 1)) set.add(key(e.x, e.z));
    }
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
  m.position.set(p.x, tileHeight(x, z) + 0.2, p.z);
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
  // Skip while hit-HUD flash owns the strip (restore timer will call us again).
  if (unitInfoHitTimer) return;
  if (!selected || selected.hp <= 0) {
    ui.unitInfo.innerHTML = phase === 'player'
      ? 'Tap a <strong>cyan</strong> unit to select, then tap a highlighted tile to move or attack.'
      : 'Rival armies are moving…';
    return;
  }
  const canMove = !selected.moved ? `Move ${selected.def.move}` : 'Moved';
  const canAtk = !selected.attacked ? `Atk ${selected.def.atk} (rng ${selected.def.minRange}–${selected.def.range})` : 'Attacked';
  ui.unitInfo.innerHTML = `<strong>${selected.def.name}</strong> · HP ${selected.hp}/${selected.maxHp}<br>${canMove} · ${canAtk}`;
}

function updateHudCounts() {
  const pc = units.filter((u) => u.faction === 'player' && u.hp > 0).length;
  const ec = units.filter((u) => u.faction !== 'player' && u.hp > 0).length;
  ui.playerCount.textContent = String(pc);
  ui.enemyCount.textContent = String(ec);
  ui.turnNum.textContent = String(turn);
}

function selectUnit(unit) {
  if (phase !== 'player' || !gameActive) return;
  if (!unit || unit.faction !== 'player' || unit.hp <= 0) return;
  selected = unit;
  clearTimeout(unitInfoHitTimer);
  unitInfoHitTimer = null;
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

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  faceBarsToCamera();
  renderer.render(scene, camera);
}

function screenToNDC(e) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
}


// Tap vs orbit/pan. Track pointers globally so two-finger pan never leaves a stale id
// that would make later single taps look like multitouch (and skip selection).
const activePointers = new Set();
let tapGesture = null; // { id, x, y, t, dragged }

function resetPointerState() {
  activePointers.clear();
  tapGesture = null;
  if (controls) {
    controls.enableRotate = true;
    controls.enablePan = true;
  }
}

function onPointerTrackEnd(e) {
  activePointers.delete(e.pointerId);
  if (tapGesture && e.pointerId === tapGesture.id) {
    const gest = tapGesture;
    tapGesture = null;
    const dt = Date.now() - gest.t;
    const dist = Math.hypot(e.clientX - gest.x, e.clientY - gest.y);
    // Only select when this was a true single-finger tap (no drag, no other fingers)
    if (
      gameActive &&
      phase === 'player' &&
      !gest.dragged &&
      dist <= 24 &&
      dt < 800 &&
      activePointers.size === 0
    ) {
      handleTap(e);
    }
  }
  if (activePointers.size === 0) {
    if (controls) {
      controls.enableRotate = true;
      controls.enablePan = true;
    }
    tapGesture = null;
  }
}

function onPointerTrackMove(e) {
  if (!tapGesture || e.pointerId !== tapGesture.id) return;
  if (activePointers.size > 1) {
    // Became a multitouch gesture — abandon tap
    tapGesture = null;
    controls.enableRotate = true;
    controls.enablePan = true;
    return;
  }
  const dist = Math.hypot(e.clientX - tapGesture.x, e.clientY - tapGesture.y);
  if (dist > 24) {
    tapGesture.dragged = true;
    controls.enableRotate = true; // one-finger orbit after clear drag
  }
}

// Bind once (module scope). pointerup/cancel/move on window catch OrbitControls capture quirks.
if (!window.__gridfallPtrBound) {
  window.__gridfallPtrBound = true;
  window.addEventListener('pointerup', onPointerTrackEnd, true);
  window.addEventListener('pointercancel', onPointerTrackEnd, true);
  window.addEventListener('pointermove', onPointerTrackMove, true);
  // If the tab/gesture is interrupted, recover controls
  window.addEventListener('blur', resetPointerState);
}

function onPointerDown(e) {
  activePointers.add(e.pointerId);

  // Two+ fingers → pan/zoom; never treat as unit tap
  if (activePointers.size > 1) {
    tapGesture = null;
    controls.enableRotate = true;
    controls.enablePan = true;
    return;
  }

  if (!gameActive || phase !== 'player') return;
  if (e.button !== undefined && e.button !== 0) return;

  // Single pointer: keep rotate enabled so OrbitControls can start an orbit gesture.
  // Only suppress pan (two-finger still pans). Tap vs drag is decided on pointerup.
  tapGesture = { id: e.pointerId, x: e.clientX, y: e.clientY, t: Date.now(), dragged: false };
  controls.enableRotate = true;
  controls.enablePan = false;
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
      return;
    }
    // Tap empty / own tile to deselect or select
    const own = unitAt(x, z);
    if (own && own.faction === 'player') selectUnit(own);
  }
}


/** Map attackMultiplier notes → compact chip descriptors (max 2). */
function bonusChips(notes) {
  const chips = [];
  for (const n of notes) {
    if (n.includes('high')) chips.push({ cls: 'high', label: '▲ +2%', hud: '▲ high' });
    else if (n.includes('formed')) chips.push({ cls: 'form', label: '◆◆ +8%', hud: '◆◆ form' });
    else if (n.includes('paired')) chips.push({ cls: 'pair', label: '◆ +4%', hud: '◆ pair' });
  }
  return chips.slice(0, 2);
}

function worldToScreen(wx, wy, wz) {
  const v = new THREE.Vector3(wx, wy, wz);
  v.project(camera);
  return {
    x: (v.x * 0.5 + 0.5) * window.innerWidth,
    y: (-v.y * 0.5 + 0.5) * window.innerHeight,
  };
}

/** Primary tell: damage float over defender (one per defender). */
function showDamageFloat(defender, dmg, notes) {
  const layer = $('dmg-floats');
  if (!layer || !defender || !defender.mesh) return;
  const prev = activeDmgFloats.get(defender);
  if (prev && prev.parentNode) prev.parentNode.removeChild(prev);
  activeDmgFloats.delete(defender);

  const el = document.createElement('div');
  el.className = 'dmg-float';
  const num = document.createElement('div');
  num.className = 'dmg-num';
  num.textContent = String(dmg);
  el.appendChild(num);
  const chips = bonusChips(notes);
  if (chips.length) {
    const row = document.createElement('div');
    row.className = 'dmg-chips';
    for (const c of chips) {
      const span = document.createElement('span');
      span.className = `dmg-chip ${c.cls}`;
      span.textContent = c.label;
      row.appendChild(span);
    }
    el.appendChild(row);
  }
  const pos = defender.mesh.position;
  const scr = worldToScreen(pos.x, pos.y + 0.85, pos.z);
  el.style.left = `${Math.round(scr.x)}px`;
  el.style.top = `${Math.round(scr.y)}px`;
  layer.appendChild(el);
  activeDmgFloats.set(defender, el);
  setTimeout(() => {
    if (el.parentNode) el.parentNode.removeChild(el);
    if (activeDmgFloats.get(defender) === el) activeDmgFloats.delete(defender);
  }, 1050);
}

/** Player-only tertiary HUD line; restores selection copy after ~1.2s. */
function showHitHud(dmg, notes) {
  clearTimeout(unitInfoHitTimer);
  const chips = bonusChips(notes);
  const parts = [`Hit ${dmg}`, ...chips.map((c) => c.hud)];
  ui.unitInfo.textContent = parts.join(' · ');
  unitInfoHitTimer = setTimeout(() => {
    unitInfoHitTimer = null;
    updateUnitInfo();
  }, 1200);
}

function flashCombat(attacker, defender, notes) {
  pulseMesh(defender.mesh);
  if (!notes.length || !attacker || !attacker.mesh) return;
  let intensity = 0.75;
  let ms = 180;
  const joined = notes.join(' ');
  if (joined.includes('formed')) { intensity = 1.15; ms = 200; }
  else if (joined.includes('paired')) { intensity = 0.95; ms = 180; }
  pulseMesh(attacker.mesh, { color: 0x3ad7ff, intensity, ms });
}

function doMove(unit, x, z) {
  unit.x = x;
  unit.z = z;
  unit.moved = true;
  const p = worldPos(x, z);
  unit.mesh.position.set(p.x, unitWorldY(x, z), p.z);
  updateIntelFromContact();
  refreshSelectionVisuals();
  updateUnitInfo();
  toast(`${unit.def.name} moved`);
}

function doAttack(attacker, defender) {
  if (attacker.attacked) return;
  const { mult, notes } = attackMultiplier(attacker, defender);
  const raw = attacker.def.atk + Math.floor(Math.random() * 2);
  const dmg = Math.max(1, Math.round(raw * mult));
  defender.hp -= dmg;
  attacker.attacked = true;
  attacker.moved = true;
  updateHpBar(defender);
  flashCombat(attacker, defender, notes);
  showDamageFloat(defender, dmg, notes);
  if (defender.hp <= 0) {
    defender.hp = 0;
    unitsGroup.remove(defender.mesh);
    toast(`${defender.def.name} destroyed!`, 1400);
  }
  updateIntelFromContact();
  refreshSelectionVisuals();
  updateHudCounts();
  showHitHud(dmg, notes);
  checkWinLose();
}

function pulseMesh(mesh, opts = {}) {
  if (!mesh) return;
  const intensity = opts.intensity != null ? opts.intensity : 0.9;
  const ms = opts.ms != null ? opts.ms : 200;
  const tint = opts.color != null ? new THREE.Color(opts.color) : null;
  const mats = [];
  mesh.traverse((c) => {
    if (c.isMesh && c.material && c.material.emissive) {
      mats.push({
        m: c.material,
        prevI: c.material.emissiveIntensity,
        prevC: c.material.emissive.clone(),
      });
    }
  });
  mats.forEach(({ m }) => {
    if (tint) m.emissive.copy(tint);
    m.emissiveIntensity = intensity;
  });
  setTimeout(() => {
    mats.forEach(({ m, prevI, prevC }) => {
      m.emissive.copy(prevC);
      m.emissiveIntensity = prevI;
    });
  }, ms);
}

function checkWinLose() {
  const pc = units.filter((u) => u.faction === 'player' && u.hp > 0).length;
  const ec = units.filter((u) => u.faction !== 'player' && u.hp > 0).length;
  if (ec === 0) endGame(true, 'All rival armies defeated. Gridfall is yours!');
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
  ui.phase.textContent = 'Enemy turn…';
  ui.phase.classList.remove('player');
  ui.phase.classList.add('enemy');
  ui.btnEnd.disabled = true;
  toast('Enemy armies moving…', 1200);
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
  // Each rival army acts separately with its own fog-of-war knowledge
  const factions = ['ember', 'ash', 'cinder'];
  // Shuffle order so they do not always pile on together
  for (let i = factions.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [factions[i], factions[j]] = [factions[j], factions[i]];
  }
  for (const fac of factions) {
    pruneFactionMemory(fac);
    factionScoutGoal[fac] = rollFactionScoutGoal(fac);
    resetUnitActions(fac);
    const squad = units.filter((u) => u.faction === fac && u.hp > 0);
    squad.sort((a, b) => a.def.range - b.def.range);
    for (const unit of squad) {
      if (phase === 'ended') return;
      await sleep(220);
      aiAct(unit);
      updateIntelFromContact();
      updateHudCounts();
      if (checkWinLoseEarly()) return;
    }
    await sleep(180);
  }
}

function checkWinLoseEarly() {
  const pc = units.filter((u) => u.faction === 'player' && u.hp > 0).length;
  const ec = units.filter((u) => u.faction !== 'player' && u.hp > 0).length;
  if (ec === 0) { endGame(true, 'All rival armies defeated. Gridfall is yours!'); return true; }
  if (pc === 0) { endGame(false, 'Your army has fallen.'); return true; }
  return false;
}

function aiAct(unit) {
  // Real act start — committed contact snapshot OK here
  updateIntelFromContact();
  const fac = unit.faction;

  // P0 — Attack now (memory id ∩ mechanical attack targets); lowest HP
  let targets = attackTargetsFromMemory(unit);
  if (targets.length) {
    targets.sort((a, b) => a.hp - b.hp);
    doAttackAI(unit, targets[0]);
    return;
  }

  const reach = bfsReachable(unit.x, unit.z, unit.def.move, unit);
  const contacts = knownContacts(fac);
  let goalX, goalZ;
  const hunt = contactGoalForUnit(fac, unit, contacts);
  if (hunt) {
    // P1 — Hunt last-known (soft-capped)
    goalX = hunt.x;
    goalZ = hunt.z;
  } else {
    // P2 — Blind scout / overflow hunters: shared faction scout goal
    if (!factionScoutGoal[fac]) factionScoutGoal[fac] = rollFactionScoutGoal(fac);
    goalX = factionScoutGoal[fac].x;
    goalZ = factionScoutGoal[fac].z;
  }

  const mem = factionMemory[fac] || new Map();
  let bestPos = null;
  let bestScore = Infinity;
  for (const k of reach) {
    const [x, z] = k.split(',').map(Number);
    const ox = unit.x, oz = unit.z;
    unit.x = x; unit.z = z;
    // Pure scoring — never mutate intel from hypothetical positions
    const hit = [...getAttackTargets(unit)].some((kk) => {
      const [tx, tz] = kk.split(',').map(Number);
      const t = unitAt(tx, tz);
      return t && mem.has(t.id);
    });
    unit.x = ox; unit.z = oz;
    const distGoal = chebyshev(x, z, goalX, goalZ);
    const score = (hit ? ATTACK_BONUS : 0) + distGoal + Math.random() * GOAL_NOISE;
    if (score < bestScore) {
      bestScore = score;
      bestPos = { x, z };
    }
  }

  if (bestPos) {
    unit.x = bestPos.x;
    unit.z = bestPos.z;
    unit.moved = true;
    const p = worldPos(bestPos.x, bestPos.z);
    unit.mesh.position.set(p.x, unitWorldY(bestPos.x, bestPos.z), p.z);
    updateIntelFromContact();

    targets = attackTargetsFromMemory(unit);
    if (targets.length) {
      targets.sort((a, b) => a.hp - b.hp);
      doAttackAI(unit, targets[0]);
    }
  }
}

function doAttackAI(attacker, defender) {
  const { mult, notes } = attackMultiplier(attacker, defender);
  const raw = attacker.def.atk + Math.floor(Math.random() * 2);
  const dmg = Math.max(1, Math.round(raw * mult));
  defender.hp -= dmg;
  attacker.attacked = true;
  attacker.moved = true;
  updateHpBar(defender);
  flashCombat(attacker, defender, notes);
  showDamageFloat(defender, dmg, notes);
  if (defender.hp <= 0) {
    defender.hp = 0;
    unitsGroup.remove(defender.mesh);
  }
  updateIntelFromContact();
}

function startGame() {
  resetPointerState();
  showOverlay(null);
  setHudVisible(true);
  buildBoard();
  spawnUnits();
  resetIntel();
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
  camera.position.set(-20, 24, -20); // cyan (SW) closest
  controls.update(); // SW — cyan army closest to camera
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

function showBuildBannerOnce() {
  if (!ui.buildBanner) return;
  try {
    if (sessionStorage.getItem('gf-build-shown') === BUILD_ID) return;
    sessionStorage.setItem('gf-build-shown', BUILD_ID);
  } catch (_) { /* private mode */ }
  ui.buildBanner.textContent = BUILD_ID;
  ui.buildBanner.classList.remove('hidden');
  ui.buildBanner.classList.add('show');
  setTimeout(() => {
    ui.buildBanner.classList.add('hidden');
    ui.buildBanner.classList.remove('show');
  }, 3200);
}

function promptSwUpdate() {
  toast('New version ready — hard-refresh or clear Safari site data', 5200);
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
      .then((reg) => {
        reg.update().catch(() => {});
        if (reg.waiting) promptSwUpdate();
        reg.addEventListener('updatefound', () => {
          const nw = reg.installing;
          if (!nw) return;
          nw.addEventListener('statechange', () => {
            if (nw.state === 'installed' && navigator.serviceWorker.controller) {
              promptSwUpdate();
            }
          });
        });
        showBuildBannerOnce();
      })
      .catch(() => {});

    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return;
      refreshing = true;
      toast('Updated — hard-refresh if the board looks stale', 4200);
    });
  });
}
