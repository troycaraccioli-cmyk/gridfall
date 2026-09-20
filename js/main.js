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

const ARMY_COLORS = {
  player:  { main: 0x3ad7ff, base: 0x145a70, name: 'Cyan' },
  ember:   { main: 0xff7a3a, base: 0x703018, name: 'Ember' },
  ash:     { main: 0xc084fc, base: 0x4a1868, name: 'Ash' },
  cinder:  { main: 0xff5577, base: 0x701828, name: 'Cinder' },
};

function isPlayer(u) { return u.faction === 'player'; }
function isEnemy(u) { return u.faction !== 'player'; }

const $ = (id) => document.getElementById(id);

const BUILD_ID = 'gridfall-v19';

const ui = {
  title: $('title-screen'),
  howto: $('howto-screen'),
  end: $('end-screen'),
  hud: $('hud'),
  bottom: $('bottom-hud'),
  hint: $('camera-hint'),
  toast: $('status-toast'),
  buildBanner: $('build-banner'),
  buildChip: $('build-chip'),
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
let tiles = []; // {x,z,mesh,obstacle,river,bridge,height}
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
/** Enemy unit → static attack-preview chip row (selection). */
const activeAttackPreviews = new Map();
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
const HEIGHT_SPAN = HEIGHT_MAX - HEIGHT_MIN;
const HEIGHT_STEP_MAX = HEIGHT_SPAN * 0.05; // max neighbor Δh in gen + non-fault edges (5% of span)
const CLIFF_MAX_EDGES = 4; // max length of the single fault chain
const CLIFF_DROP = HEIGHT_SPAN * 0.45; // height separation across fault
const DIRS8 = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];

/** Canonical ortho cliff-edge keys only (v2: not inferred from raw |Δh|). */
let cliffEdges = new Set();
/** Water materials for cheap emissive pulse (Feel geography). */
let waterMats = [];

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
  const fill = new THREE.DirectionalLight(0x4499ff, 0.37);
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

function heightDelta(ax, az, bx, bz) {
  return tileHeight(ax, az) - tileHeight(bx, bz);
}

/** Ordered pair key so (A,B) and (B,A) share membership. */
function edgeKey(ax, az, bx, bz) {
  if (ax < bx || (ax === bx && az < bz)) return `${ax},${az}|${bx},${bz}`;
  return `${bx},${bz}|${ax},${az}`;
}

function isCliffEdge(ax, az, bx, bz) {
  return cliffEdges.has(edgeKey(ax, az, bx, bz));
}

/** Standing on high lip looking at low tile across a registered cliff edge. */
function isCliffDown(fromX, fromZ, toX, toZ) {
  return isCliffEdge(fromX, fromZ, toX, toZ)
    && tileHeight(fromX, fromZ) > tileHeight(toX, toZ);
}

function cliffEndpointKeys() {
  const s = new Set();
  for (const ek of cliffEdges) {
    const parts = ek.split('|');
    if (parts.length === 2) {
      s.add(parts[0]);
      s.add(parts[1]);
    }
  }
  return s;
}

function isWater(x, z) {
  const t = tileAt(x, z);
  return !!(t && t.river && !t.bridge);
}

function isBridge(x, z) {
  const t = tileAt(x, z);
  return !!(t && t.bridge);
}

function blocksMove(x, z) {
  const t = tileAt(x, z);
  if (!t || t.obstacle) return true;
  if (t.river && !t.bridge) return true;
  return false;
}

/** Seeded tile color variation ±5%. */
function jitterColor(col, u) {
  const j = 1 + (u - 0.5) * 0.1;
  col.r = Math.min(1, Math.max(0, col.r * j));
  col.g = Math.min(1, Math.max(0, col.g * j));
  col.b = Math.min(1, Math.max(0, col.b * j));
  return col;
}

function landBandColor(tHigh, wet, u) {
  let col;
  if (tHigh < 0.35) {
    const a = new THREE.Color(0x3a3428);
    const b = new THREE.Color(0x4a4030);
    col = a.lerp(b, tHigh / 0.35);
  } else if (tHigh < 0.72) {
    const a = new THREE.Color(0x2f5a38);
    const b = new THREE.Color(0x3d7a48);
    col = a.lerp(b, (tHigh - 0.35) / 0.37);
  } else {
    const a = new THREE.Color(0x5a6570);
    const b = new THREE.Color(0x6a7380);
    col = a.lerp(b, (tHigh - 0.72) / 0.28);
  }
  jitterColor(col, u);
  if (wet) col.lerp(new THREE.Color(0x243028), 0.55);
  return col;
}

function landRoughness(tHigh, wet) {
  if (wet) return 0.92;
  if (tHigh < 0.35) return 0.88;
  if (tHigh < 0.72) return 0.82;
  return 0.92;
}

/**
 * Clamp ortho neighbor steps to maxStep.
 * skipKeys: fault edge keys — never clamp across them.
 * frozenKeys: cell keys (fault endpoints) — height pinned; only free neighbors move.
 */
function clampHeightSteps(h, maxStep, skipKeys = null, frozenKeys = null) {
  // Post-normalize full-span maps need many passes to settle at 5% step (span compresses).
  for (let iter = 0; iter < 500; iter++) {
    let changed = false;
    for (let z = 0; z < GRID; z++) {
      for (let x = 0; x < GRID; x++) {
        for (const [dx, dz] of [[1, 0], [0, 1]]) {
          const nx = x + dx, nz = z + dz;
          if (!inBounds(nx, nz)) continue;
          if (skipKeys && skipKeys.has(edgeKey(x, z, nx, nz))) continue;
          const aF = frozenKeys && frozenKeys.has(key(x, z));
          const bF = frozenKeys && frozenKeys.has(key(nx, nz));
          if (aF && bF) continue; // both pinned (e.g. adjacent lip cells)
          const d = h[nz][nx] - h[z][x];
          if (Math.abs(d) <= maxStep + 1e-9) continue;
          if (aF) {
            // Pin A; pull B within maxStep of A
            h[nz][nx] = h[z][x] + (d > 0 ? maxStep : -maxStep);
            changed = true;
            continue;
          }
          if (bF) {
            h[z][x] = h[nz][nx] - (d > 0 ? maxStep : -maxStep);
            changed = true;
            continue;
          }
          const mid = (h[z][x] + h[nz][nx]) / 2;
          const half = maxStep / 2;
          if (d > 0) { h[z][x] = mid - half; h[nz][nx] = mid + half; }
          else { h[z][x] = mid + half; h[nz][nx] = mid - half; }
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
}

/** Generate smooth heightmap; neighbor Δh clamped with HEIGHT_STEP_MAX only (no gen cliffs). */
function generateHeights(rand) {
  const h = Array.from({ length: GRID }, () => Array(GRID).fill(0));
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
  clampHeightSteps(h, HEIGHT_STEP_MAX);
  // Normalize into [HEIGHT_MIN, HEIGHT_MAX] while preserving relative diffs roughly
  let mn = Infinity, mx = -Infinity;
  for (let z = 0; z < GRID; z++) for (let x = 0; x < GRID; x++) {
    mn = Math.min(mn, h[z][x]); mx = Math.max(mx, h[z][x]);
  }
  const span = Math.max(1e-6, mx - mn);
  for (let z = 0; z < GRID; z++) for (let x = 0; x < GRID; x++) {
    h[z][x] = HEIGHT_MIN + ((h[z][x] - mn) / span) * (HEIGHT_MAX - HEIGHT_MIN);
  }
  clampHeightSteps(h, HEIGHT_STEP_MAX);
  return h;
}

function assertNoGenCliffs(h) {
  const eps = 1e-6;
  for (let z = 0; z < GRID; z++) {
    for (let x = 0; x < GRID; x++) {
      for (const [dx, dz] of [[1, 0], [0, 1]]) {
        const nx = x + dx, nz = z + dz;
        if (!inBounds(nx, nz)) continue;
        if (Math.abs(h[nz][nx] - h[z][x]) > HEIGHT_STEP_MAX + eps) {
          console.warn('gen cliff leak', x, z, nx, nz, h[z][x], h[nz][nx]);
          return false;
        }
      }
    }
  }
  return true;
}

/**
 * Inject exactly one contiguous ortho cliff fault (polyline wall).
 * Clearest ship: straight cardinal wall of N edges; high lip = one side of the cut.
 * N∈[1,4] prefer 2–4; spawn 5×5 safe; rocks preferred skip; height drop CLIFF_DROP.
 */
function injectCliffFault(h, obstacles, banned, rand) {
  cliffEdges.clear();

  const rollN = () => {
    const r = rand();
    if (r < 0.08) return 1; // rare single edge
    if (r < 0.36) return 2;
    if (r < 0.68) return 3;
    return 4;
  };

  const edgeOk = (ax, az, bx, bz, allowRock) => {
    if (!inBounds(ax, az) || !inBounds(bx, bz)) return false;
    if (banned.has(key(ax, az)) || banned.has(key(bx, bz))) return false;
    if (!allowRock && (obstacles.has(key(ax, az)) || obstacles.has(key(bx, bz)))) return false;
    return true;
  };

  /** Straight wall: N parallel ortho edges forming a continuous cut. */
  const tryStraightWall = (N, allowRock) => {
    const horizontal = rand() < 0.5; // wall faces N/S (edges between z and z+1)
    if (horizontal) {
      const z0 = Math.floor(rand() * (GRID - 1)); // low-side row candidate
      const x0 = Math.floor(rand() * (GRID - N + 1));
      const edges = [];
      for (let i = 0; i < N; i++) {
        const ax = x0 + i, az = z0, bx = x0 + i, bz = z0 + 1;
        if (!edgeOk(ax, az, bx, bz, allowRock)) return null;
        edges.push([ax, az, bx, bz]);
      }
      const highIsLowZ = rand() < 0.5;
      return { edges, highIsA: highIsLowZ }; // A=(x,z0) vs B=(x,z0+1)
    }
    const x0 = Math.floor(rand() * (GRID - 1));
    const z0 = Math.floor(rand() * (GRID - N + 1));
    const edges = [];
    for (let i = 0; i < N; i++) {
      const ax = x0, az = z0 + i, bx = x0 + 1, bz = z0 + i;
      if (!edgeOk(ax, az, bx, bz, allowRock)) return null;
      edges.push([ax, az, bx, bz]);
    }
    const highIsA = rand() < 0.5;
    return { edges, highIsA };
  };

  const applyPlacement = (placement) => {
    const { edges, highIsA } = placement;
    const frozen = new Set();
    for (const [ax, az, bx, bz] of edges) {
      const hx = highIsA ? ax : bx;
      const hz = highIsA ? az : bz;
      const lx = highIsA ? bx : ax;
      const lz = highIsA ? bz : az;
      const lo = h[lz][lx];
      h[hz][hx] = Math.min(HEIGHT_MAX, lo + CLIFF_DROP);
      cliffEdges.add(edgeKey(ax, az, bx, bz));
      frozen.add(key(ax, az));
      frozen.add(key(bx, bz));
    }
    // Re-clamp non-fault edges only; pin fault endpoints so CLIFF_DROP is preserved
    clampHeightSteps(h, HEIGHT_STEP_MAX, cliffEdges, frozen);
  };

  for (let attempt = 0; attempt < 24; attempt++) {
    const N = rollN();
    const allowRock = attempt >= 16; // late attempts may touch rocks
    const placement = tryStraightWall(N, allowRock);
    if (placement) {
      applyPlacement(placement);
      return;
    }
  }

  // Fallback: 2-edge fault in center band x,z ∈ [5..10]
  cliffEdges.clear();
  const edges = [[7, 7, 7, 8], [8, 7, 8, 8]];
  applyPlacement({ edges, highIsA: true });
}

function countAdjacentAllies(unit) {
  let n = 0;
  for (const o of units) {
    if (o === unit || o.hp <= 0 || o.faction !== unit.faction) continue;
    if (chebyshev(unit.x, unit.z, o.x, o.z) === 1) n++;
  }
  return n;
}

/** Attacker damage multiplier: elev bands +4/+8/+12/+16%, cluster +4%/+8%. */
function attackMultiplier(attacker, defender) {
  let m = 1;
  const notes = [];
  const elev = (tileHeight(attacker.x, attacker.z) - tileHeight(defender.x, defender.z)) / HEIGHT_SPAN;
  if (elev >= 0.60) { m *= 1.16; notes.push('high +16%'); }
  else if (elev >= 0.35) { m *= 1.12; notes.push('high +12%'); }
  else if (elev >= 0.15) { m *= 1.08; notes.push('high +8%'); }
  else if (elev > 0) { m *= 1.04; notes.push('high +4%'); }
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
    if (tile && !blocksMove(x, z)) return { x, z };
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
    if (tile && !blocksMove(x, z)) return { x, z };
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



/** Flood on gen sets (before meshes) — 8-dir with water/cliff corner rules. */
function walkableRegionFromSets(sx, sz, obstacles, riverSet, bridgeSet) {
  const blocked = (x, z) => {
    const k = key(x, z);
    if (obstacles.has(k)) return true;
    if (riverSet.has(k) && !bridgeSet.has(k)) return true;
    return false;
  };
  const seen = new Set();
  const q = [[sx, sz]];
  seen.add(key(sx, sz));
  while (q.length) {
    const [x, z] = q.shift();
    for (const [dx, dz] of DIRS8) {
      const nx = x + dx, nz = z + dz;
      if (!inBounds(nx, nz)) continue;
      const nk = key(nx, nz);
      if (seen.has(nk)) continue;
      if (blocked(nx, nz)) continue;
      if (dx !== 0 && dz !== 0) {
        if (isCliffEdge(x, z, nx, z) || isCliffEdge(x, z, x, nz)) continue;
        // corner-cut across open water
        const midA = key(nx, z), midB = key(x, nz);
        if ((riverSet.has(midA) && !bridgeSet.has(midA)) || (riverSet.has(midB) && !bridgeSet.has(midB))) continue;
      } else if (isCliffEdge(x, z, nx, nz)) {
        continue;
      }
      seen.add(nk);
      q.push([nx, nz]);
    }
  }
  return seen;
}

function banksLinkedByBridge(obstacles, riverSet, bridgeSet) {
  // Cyan SW landmark ↔ Cinder NE must connect via bridge
  if (obstacles.has(key(2, 2)) || obstacles.has(key(13, 13))) return false;
  if (riverSet.has(key(2, 2)) && !bridgeSet.has(key(2, 2))) return false;
  if (riverSet.has(key(13, 13)) && !bridgeSet.has(key(13, 13))) return false;
  const withBr = walkableRegionFromSets(2, 2, obstacles, riverSet, bridgeSet);
  if (!withBr.has(key(13, 13))) return false;
  const emptyBr = new Set();
  const without = walkableRegionFromSets(2, 2, obstacles, riverSet, emptyBr);
  if (without.has(key(13, 13))) return false; // river didn't seal
  return true;
}

function placeRocks(banned, cliffEnds, rand) {
  const obstacles = new Set();
  const candidates = [];
  for (let z = 0; z < GRID; z++) {
    for (let x = 0; x < GRID; x++) {
      const k = key(x, z);
      if (banned.has(k)) continue;
      if (cliffEnds.has(k)) continue;
      candidates.push([x, z]);
    }
  }
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  for (let i = 0; i < 20 && i < candidates.length; i++) {
    obstacles.add(key(candidates[i][0], candidates[i][1]));
  }
  return obstacles;
}

function riverCellIllegal(x, z, riverSet, obstacles, banned, cliffEnds) {
  if (!inBounds(x, z)) return true;
  const k = key(x, z);
  if (banned.has(k) || obstacles.has(k) || cliffEnds.has(k)) return true;
  if (riverSet.has(k)) return true;
  // Cannot mark both endpoints of any cliff edge as river
  for (const ek of cliffEdges) {
    const parts = ek.split('|');
    if (parts.length !== 2) continue;
    const [ax, az] = parts[0].split(',').map(Number);
    const [bx, bz] = parts[1].split(',').map(Number);
    const aR = riverSet.has(parts[0]) || (ax === x && az === z);
    const bR = riverSet.has(parts[1]) || (bx === x && bz === z);
    if (aR && bR) return true;
  }
  return false;
}

/**
 * Winding 1-wide border-to-border river in mid-board band.
 * Returns Set of "x,z" keys or null.
 */
function tryGenerateRiver(obstacles, banned, rand) {
  const cliffEnds = cliffEndpointKeys();
  const eastWest = rand() < 0.5;
  const band = [5, 6, 7, 8, 9, 10];

  const inSoftBand = (x, z) => {
    if (eastWest) return z >= 4 && z <= 11;
    return x >= 4 && x <= 11;
  };

  // Entry on start border inside mid band
  const entries = [];
  if (eastWest) {
    for (const z of band) {
      if (!riverCellIllegal(0, z, new Set(), obstacles, banned, cliffEnds)) entries.push([0, z]);
    }
  } else {
    for (const x of band) {
      if (!riverCellIllegal(x, 0, new Set(), obstacles, banned, cliffEnds)) entries.push([x, 0]);
    }
  }
  if (!entries.length) return null;
  const start = entries[Math.floor(rand() * entries.length)];

  const path = [start];
  const riverSet = new Set([key(start[0], start[1])]);
  let x = start[0], z = start[1];
  const targetCoord = GRID - 1;
  const maxSteps = GRID * 6;

  for (let step = 0; step < maxSteps; step++) {
    const atEnd = eastWest ? (x === targetCoord) : (z === targetCoord);
    if (atEnd && path.length >= 8) return riverSet;

    const progress = eastWest ? x : z;
    const options = [];
    const ortho = eastWest
      ? [[1, 0], [1, 1], [1, -1], [0, 1], [0, -1], [-1, 0]]
      : [[0, 1], [1, 1], [-1, 1], [1, 0], [-1, 0], [0, -1]];

    for (const [dx, dz] of ortho) {
      const nx = x + dx, nz = z + dz;
      if (riverCellIllegal(nx, nz, riverSet, obstacles, banned, cliffEnds)) continue;
      if (!inSoftBand(nx, nz) && rand() > 0.15) continue; // rare jitter outside band
      // Prefer forward progress
      const nProg = eastWest ? nx : nz;
      let w = 1;
      if (nProg > progress) w = 6;
      else if (nProg === progress) w = 2;
      else w = 0.35;
      // Prefer staying in hard mid band
      if (eastWest ? (nz >= 5 && nz <= 10) : (nx >= 5 && nx <= 10)) w *= 1.5;
      options.push({ nx, nz, w });
    }

    if (!options.length) {
      // Backtrack
      if (path.length <= 1) return null;
      path.pop();
      riverSet.delete(key(x, z));
      [x, z] = path[path.length - 1];
      continue;
    }

    let total = 0;
    for (const o of options) total += o.w;
    let r = rand() * total;
    let pick = options[0];
    for (const o of options) {
      r -= o.w;
      if (r <= 0) { pick = o; break; }
    }
    x = pick.nx; z = pick.nz;
    path.push([x, z]);
    riverSet.add(key(x, z));
  }

  const sealed = eastWest
    ? [...riverSet].some((k) => +k.split(',')[0] === 0) && [...riverSet].some((k) => +k.split(',')[0] === GRID - 1)
    : [...riverSet].some((k) => +k.split(',')[1] === 0) && [...riverSet].some((k) => +k.split(',')[1] === GRID - 1);
  if (sealed && riverSet.size >= 8) return riverSet;
  return null;
}

function forceFallbackRiver(obstacles, banned) {
  // Guaranteed E–W cut at z=8 (skip illegal cells by shifting locally)
  const cliffEnds = cliffEndpointKeys();
  const riverSet = new Set();
  let z = 8;
  for (let x = 0; x < GRID; x++) {
    let placed = false;
    for (const dz of [0, -1, 1, -2, 2]) {
      const zz = z + dz;
      if (riverCellIllegal(x, zz, riverSet, obstacles, banned, cliffEnds)) continue;
      riverSet.add(key(x, zz));
      z = zz;
      placed = true;
      break;
    }
    if (!placed) {
      // last resort: clear rock on mid cell
      const zz = Math.max(5, Math.min(10, z));
      obstacles.delete(key(x, zz));
      if (!banned.has(key(x, zz)) && !cliffEnds.has(key(x, zz))) {
        riverSet.add(key(x, zz));
        z = zz;
      }
    }
  }
  return riverSet.size >= 8 ? riverSet : null;
}

/**
 * Exactly one bridge of 1–2 contiguous river tiles.
 * Returns Set of bridge keys or null.
 */
function placeBridge(riverSet, obstacles, banned, rand) {
  const cliffEnds = cliffEndpointKeys();
  const cells = [...riverSet].map((k) => {
    const [x, z] = k.split(',').map(Number);
    return { x, z, k };
  });

  const landNeighbors = (x, z) => {
    const out = [];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz;
      if (!inBounds(nx, nz)) continue;
      const nk = key(nx, nz);
      if (riverSet.has(nk)) continue;
      if (obstacles.has(nk)) continue;
      out.push({ x: nx, z: nz, dx, dz });
    }
    return out;
  };

  /** Prefer sites with walkable land on both sides of the local river cut. */
  const bothBanks = (cells) => {
    // Infer cut axis from river neighborhood: if more river along X, river is E–W (cut N/S)
    let rivX = 0, rivZ = 0;
    for (const c of cells) {
      if (riverSet.has(key(c.x - 1, c.z)) || riverSet.has(key(c.x + 1, c.z))) rivX++;
      if (riverSet.has(key(c.x, c.z - 1)) || riverSet.has(key(c.x, c.z + 1))) rivZ++;
    }
    const eastWestRiver = rivX >= rivZ; // separates N/S → need land with dz signs
    const lands = [];
    for (const c of cells) lands.push(...landNeighbors(c.x, c.z));
    if (!lands.length) return false;
    if (eastWestRiver) {
      const hasN = lands.some((l) => l.z < Math.min(...cells.map((c) => c.z)) || l.dz < 0);
      const hasS = lands.some((l) => l.z > Math.max(...cells.map((c) => c.z)) || l.dz > 0);
      // Simpler: opposite dz signs among ortho land neighbors
      const negs = lands.some((l) => l.dz < 0);
      const poss = lands.some((l) => l.dz > 0);
      return negs && poss;
    }
    const negs = lands.some((l) => l.dx < 0);
    const poss = lands.some((l) => l.dx > 0);
    return negs && poss;
  };

  const landNeighborOk = (x, z) => landNeighbors(x, z).length > 0;

  const cliffDist = (x, z) => {
    let best = Infinity;
    for (const ck of cliffEnds) {
      const [cx, cz] = ck.split(',').map(Number);
      best = Math.min(best, chebyshev(x, z, cx, cz));
    }
    return best;
  };

  const singles = [];
  for (const c of cells) {
    if (banned.has(c.k) || cliffEnds.has(c.k)) continue;
    if (!landNeighborOk(c.x, c.z)) continue;
    singles.push(c);
  }

  const pairs = [];
  for (const a of cells) {
    for (const [dx, dz] of [[1, 0], [0, 1]]) {
      const bx = a.x + dx, bz = a.z + dz;
      const bk = key(bx, bz);
      if (!riverSet.has(bk)) continue;
      if (banned.has(a.k) || banned.has(bk)) continue;
      if (cliffEnds.has(a.k) || cliffEnds.has(bk)) continue;
      if (!landNeighborOk(a.x, a.z) && !landNeighborOk(bx, bz)) continue;
      pairs.push([a, { x: bx, z: bz, k: bk }]);
    }
  }

  const wantTwo = rand() < 0.5;
  const tryList = [];
  if (wantTwo && pairs.length) {
    for (const p of pairs) tryList.push(p);
    for (const s of singles) tryList.push([s]);
  } else {
    for (const s of singles) tryList.push([s]);
    for (const p of pairs) tryList.push(p);
  }

  if (!tryList.length) return null;

  // Prefer both-bank access, then soft ≥2 Chebyshev from cliff endpoints
  tryList.sort((a, b) => {
    const ba = bothBanks(a) ? 0 : 1;
    const bb = bothBanks(b) ? 0 : 1;
    if (ba !== bb) return ba - bb;
    const da = Math.min(...a.map((c) => cliffDist(c.x, c.z)));
    const db = Math.min(...b.map((c) => cliffDist(c.x, c.z)));
    const sa = da >= 2 ? 0 : 1;
    const sb = db >= 2 ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return da - db;
  });

  const both = tryList.filter((p) => bothBanks(p));
  const soft = (both.length ? both : tryList).filter(
    (p) => Math.min(...p.map((c) => cliffDist(c.x, c.z))) >= 2
  );
  const pool = soft.length ? soft : (both.length ? both : tryList);
  const pick = pool[Math.floor(rand() * pool.length)];
  return new Set(pick.map((c) => c.k));
}

function forceFallbackBridge(riverSet, banned) {
  const cliffEnds = cliffEndpointKeys();
  const cells = [...riverSet].map((k) => {
    const [x, z] = k.split(',').map(Number);
    return { x, z, k };
  }).filter((c) => !banned.has(c.k) && !cliffEnds.has(c.k));
  // Prefer center-ish
  cells.sort((a, b) => Math.abs(a.x - 7.5) + Math.abs(a.z - 7.5) - (Math.abs(b.x - 7.5) + Math.abs(b.z - 7.5)));
  if (!cells.length) {
    // absolute last resort
    const any = [...riverSet][Math.floor(riverSet.size / 2)];
    return new Set([any]);
  }
  return new Set([cells[0].k]);
}

function applyRiverChannelHeights(heights, riverSet, bridgeSet) {
  // Lower open-water cells toward a flat channel; bridges keep near-bank height
  for (const k of riverSet) {
    if (bridgeSet.has(k)) continue;
    const [x, z] = k.split(',').map(Number);
    heights[z][x] = HEIGHT_MIN + HEIGHT_SPAN * 0.06;
  }
  for (const k of bridgeSet) {
    const [x, z] = k.split(',').map(Number);
    let sum = 0, n = 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz;
      if (!inBounds(nx, nz)) continue;
      const nk = key(nx, nz);
      if (riverSet.has(nk) && !bridgeSet.has(nk)) continue;
      sum += heights[nz][nx];
      n++;
    }
    heights[z][x] = n ? sum / n : HEIGHT_MIN + HEIGHT_SPAN * 0.2;
  }
  // Soft re-clamp away from fault edges; freeze river+bridge so channel holds
  const frozen = new Set([...riverSet, ...bridgeSet]);
  for (const ck of cliffEndpointKeys()) frozen.add(ck);
  clampHeightSteps(heights, HEIGHT_STEP_MAX, cliffEdges, frozen);
}

function buildBoard() {
  while (boardGroup.children.length) boardGroup.remove(boardGroup.children[0]);
  tiles = [];
  waterMats = [];

  const banned = new Set();
  for (let z = 0; z < 5; z++) for (let x = 0; x < 5; x++) banned.add(key(x, z));
  for (let z = 0; z < 5; z++) for (let x = GRID - 5; x < GRID; x++) banned.add(key(x, z));
  for (let z = GRID - 5; z < GRID; z++) for (let x = 0; x < 5; x++) banned.add(key(x, z));
  for (let z = GRID - 5; z < GRID; z++) for (let x = GRID - 5; x < GRID; x++) banned.add(key(x, z));

  let seed = (Math.floor(Math.random() * 2147483646) + 1);
  const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

  let heights = null;
  let obstacles = new Set();
  let riverSet = null;
  let bridgeSet = null;

  // Gen order: heights → cliff → rocks → river → bridge; river tries + cliff rerolls
  for (let cliffAttempt = 0; cliffAttempt < 3; cliffAttempt++) {
    heights = generateHeights(rand);
    assertNoGenCliffs(heights);
    injectCliffFault(heights, new Set(), banned, rand); // rocks come after cliff
    const cliffEnds = cliffEndpointKeys();
    obstacles = placeRocks(banned, cliffEnds, rand);

    riverSet = null;
    for (let r = 0; r < 16; r++) {
      riverSet = tryGenerateRiver(obstacles, banned, rand);
      if (riverSet) break;
    }
    if (!riverSet) continue; // reroll cliff (max 2 rerolls)

    bridgeSet = placeBridge(riverSet, obstacles, banned, rand);
    if (bridgeSet && bridgeSet.size >= 1) {
      // Ensure bridge actually links opposite corners; else retry
      if (banksLinkedByBridge(obstacles, riverSet, bridgeSet)) break;
    }
    bridgeSet = null;
    riverSet = null;
  }

  if (!riverSet) {
    heights = generateHeights(rand);
    assertNoGenCliffs(heights);
    injectCliffFault(heights, new Set(), banned, rand);
    obstacles = placeRocks(banned, cliffEndpointKeys(), rand);
    riverSet = forceFallbackRiver(obstacles, banned) || forceFallbackRiver(new Set(), banned);
  }
  if (!bridgeSet) {
    bridgeSet = placeBridge(riverSet, obstacles, banned, rand) || forceFallbackBridge(riverSet, banned);
  }

  // Last-resort: try several bridge sites until banks link
  if (!banksLinkedByBridge(obstacles, riverSet, bridgeSet)) {
    let linked = false;
    for (let i = 0; i < 24; i++) {
      const alt = placeBridge(riverSet, obstacles, banned, rand) || forceFallbackBridge(riverSet, banned);
      if (alt && banksLinkedByBridge(obstacles, riverSet, alt)) {
        bridgeSet = alt;
        linked = true;
        break;
      }
    }
    if (!linked) {
      // Clear rocks near mid-board river to open approaches, then force center bridge
      for (const k of [...riverSet]) {
        const [x, z] = k.split(',').map(Number);
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]]) {
          obstacles.delete(key(x + dx, z + dz));
        }
      }
      bridgeSet = forceFallbackBridge(riverSet, banned);
    }
  }

  // Bridge sits on river
  for (const k of bridgeSet) riverSet.add(k);

  applyRiverChannelHeights(heights, riverSet, bridgeSet);

  // Neighbor wet-bank detection uses final river/bridge flags
  const isOpenWaterKey = (k) => riverSet.has(k) && !bridgeSet.has(k);

  for (let z = 0; z < GRID; z++) {
    for (let x = 0; x < GRID; x++) {
      const k = key(x, z);
      const isObs = obstacles.has(k);
      const isRiv = riverSet.has(k);
      const isBr = bridgeSet.has(k);
      const height = heights[z][x];
      const tHigh = (height - HEIGHT_MIN) / Math.max(1e-6, HEIGHT_MAX - HEIGHT_MIN);
      const geo = new THREE.BoxGeometry(TILE * 1.02, 0.18 + height, TILE * 1.02);
      const uJitter = ((x * 73 + z * 19) % 100) / 100;

      let wet = false;
      if (!isObs && !isRiv) {
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          if (isOpenWaterKey(key(x + dx, z + dz))) { wet = true; break; }
        }
      }

      let mat;
      if (isBr) {
        // Wooden bridge — more solid plank read
        mat = new THREE.MeshStandardMaterial({
          color: new THREE.Color(0x6b4a2e).lerp(new THREE.Color(0x8a6238), uJitter),
          roughness: 0.75,
          metalness: 0.05,
          transparent: true,
          opacity: 0.85,
        });
      } else if (isRiv) {
        const wcol = new THREE.Color(0x0a3a52).lerp(new THREE.Color(0x0e4a62), uJitter);
        mat = new THREE.MeshStandardMaterial({
          color: wcol,
          roughness: 0.25,
          metalness: 0.35,
          transparent: true,
          opacity: 0.7,
          emissive: new THREE.Color(0x0a3048),
          emissiveIntensity: 0.1,
        });
        waterMats.push(mat);
      } else if (isObs) {
        mat = new THREE.MeshStandardMaterial({
          color: 0x5c6574,
          roughness: 0.9,
          metalness: 0.08,
          transparent: true,
          opacity: 0.85,
        });
      } else {
        const col = landBandColor(tHigh, wet, uJitter);
        const tileOpacity = wet ? (0.52 + tHigh * 0.1) : (0.55 + tHigh * 0.15);
        mat = new THREE.MeshStandardMaterial({
          color: col,
          roughness: landRoughness(tHigh, wet),
          metalness: 0.06,
          transparent: true,
          opacity: tileOpacity,
        });
        if (!wet && tHigh >= 0.7) {
          mat.emissive = new THREE.Color(0x2a6a72);
          mat.emissiveIntensity = 0.18;
        }
      }

      const mesh = new THREE.Mesh(geo, mat);
      const p = worldPos(x, z);
      const topY = (0.18 + height) / 2;
      mesh.position.set(p.x, topY, p.z);
      mesh.receiveShadow = true;
      mesh.castShadow = true;
      mesh.userData = { type: 'tile', x, z };
      boardGroup.add(mesh);

      // Bridge side faces slightly darker
      if (isBr) {
        const side = new THREE.Mesh(
          new THREE.BoxGeometry(TILE * 1.0, Math.max(0.08, 0.12 + height * 0.5), TILE * 1.0),
          new THREE.MeshStandardMaterial({
            color: 0x3a2818,
            roughness: 0.85,
            transparent: true,
            opacity: 0.8,
          })
        );
        side.position.set(p.x, topY * 0.55, p.z);
        side.userData = { type: 'bridgeSide' };
        boardGroup.add(side);
        // Plank stripes across span (prefer river axis by neighbors)
        let alongX = true;
        const nRivX = (riverSet.has(key(x - 1, z)) ? 1 : 0) + (riverSet.has(key(x + 1, z)) ? 1 : 0);
        const nRivZ = (riverSet.has(key(x, z - 1)) ? 1 : 0) + (riverSet.has(key(x, z + 1)) ? 1 : 0);
        alongX = nRivZ >= nRivX; // planks cross the river (perpendicular to flow)
        for (let i = 0; i < 4; i++) {
          const t = (i - 1.5) / 4;
          const strip = new THREE.Mesh(
            alongX
              ? new THREE.PlaneGeometry(TILE * 0.9, TILE * 0.06)
              : new THREE.PlaneGeometry(TILE * 0.06, TILE * 0.9),
            new THREE.MeshBasicMaterial({
              color: 0x3a2818,
              transparent: true,
              opacity: 0.45,
              depthWrite: false,
            })
          );
          strip.rotation.x = -Math.PI / 2;
          if (alongX) strip.position.set(p.x, height + 0.19, p.z + t * TILE);
          else strip.position.set(p.x + t * TILE, height + 0.19, p.z);
          boardGroup.add(strip);
        }
      }

      // Soft high-tile rim (land crest only)
      if (!isObs && !isRiv && !wet && tHigh >= 0.7) {
        const rim = new THREE.Mesh(
          new THREE.PlaneGeometry(TILE * 0.92, TILE * 0.92),
          new THREE.MeshBasicMaterial({
            color: 0x5ec4c8,
            transparent: true,
            opacity: 0.22,
            depthWrite: false,
          })
        );
        rim.rotation.x = -Math.PI / 2;
        rim.position.set(p.x, height + 0.185, p.z);
        boardGroup.add(rim);
      }

      if (isObs) {
        // Richer layered rock prop
        const rockMatA = new THREE.MeshStandardMaterial({ color: 0x5c6574, roughness: 0.9, metalness: 0.05 });
        const rockMatB = new THREE.MeshStandardMaterial({ color: 0x7a8494, roughness: 0.88, metalness: 0.08 });
        const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.32, 0), rockMatA);
        rock.position.set(p.x, height + 0.42, p.z);
        rock.rotation.set(uJitter * 1.7, uJitter * 2.1, 0.3);
        rock.castShadow = true;
        const rock2 = new THREE.Mesh(new THREE.DodecahedronGeometry(0.2, 0), rockMatB);
        rock2.position.set(p.x + 0.12, height + 0.34, p.z - 0.08);
        rock2.castShadow = true;
        boardGroup.add(rock, rock2);
      }

      tiles.push({
        x, z, mesh,
        obstacle: isObs,
        river: isRiv,
        bridge: isBr,
        height,
      });
    }
  }

  // Foam edge: ortho water ↔ land (non-water)
  const foamMat = new THREE.MeshBasicMaterial({
    color: 0xc8e8f0,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
  });
  for (let z = 0; z < GRID; z++) {
    for (let x = 0; x < GRID; x++) {
      if (!isOpenWaterKey(key(x, z))) continue;
      const hW = tileHeight(x, z);
      const pW = worldPos(x, z);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, nz = z + dz;
        if (!inBounds(nx, nz)) continue;
        const nk = key(nx, nz);
        if (isOpenWaterKey(nk)) continue;
        // land, bridge, or rock bank
        const foamW = TILE * 0.06;
        const geo = dx !== 0
          ? new THREE.PlaneGeometry(foamW, TILE * 0.9)
          : new THREE.PlaneGeometry(TILE * 0.9, foamW);
        const foam = new THREE.Mesh(geo, foamMat);
        foam.rotation.x = -Math.PI / 2;
        foam.position.set(
          pW.x + dx * (TILE * 0.47),
          hW + 0.195,
          pW.z + dz * (TILE * 0.47)
        );
        foam.userData = { type: 'foam' };
        boardGroup.add(foam);
      }
    }
  }

  // Cliff faces from Systems isCliffEdge — steep dark steps only where flagged
  const cliffMat = new THREE.MeshStandardMaterial({
    color: 0x0e1a2c,
    roughness: 0.95,
    metalness: 0.02,
    transparent: true,
    opacity: 0.68,
    flatShading: true,
  });
  for (let z = 0; z < GRID; z++) {
    for (let x = 0; x < GRID; x++) {
      for (const [dx, dz] of [[1, 0], [0, 1]]) {
        const nx = x + dx, nz = z + dz;
        if (!inBounds(nx, nz)) continue;
        if (!isCliffEdge(x, z, nx, nz)) continue;
        const hA = tileHeight(x, z);
        const hB = tileHeight(nx, nz);
        const drop = Math.abs(hA - hB);
        const faceH = Math.max(0.06, drop);
        const pA = worldPos(x, z);
        const pB = worldPos(nx, nz);
        const cx = (pA.x + pB.x) / 2;
        const cz = (pA.z + pB.z) / 2;
        const topLo = 0.18 + Math.min(hA, hB);
        const geo = dx !== 0
          ? new THREE.BoxGeometry(0.07, faceH, TILE * 0.98)
          : new THREE.BoxGeometry(TILE * 0.98, faceH, 0.07);
        const face = new THREE.Mesh(geo, cliffMat);
        face.position.set(cx, topLo + faceH / 2, cz);
        face.castShadow = true;
        face.receiveShadow = true;
        face.userData = { type: 'cliff' };
        boardGroup.add(face);
      }
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
      retaliated: false,
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
      // Water blocks move; bridge is walkable
      if (t.river && !t.bridge) continue;
      // Ortho fault edges block; diagonal blocked if either ortho leg from current is a cliff (no corner-cut)
      if (dx !== 0 && dz !== 0) {
        if (isCliffEdge(x, z, nx, z) || isCliffEdge(x, z, x, nz)) continue;
        // No diagonal corner-cut across open water (keeps 1-wide river a real cut under 8-dir move)
        if (isWater(nx, z) || isWater(x, nz)) continue;
      } else if (isCliffEdge(x, z, nx, nz)) {
        continue;
      }
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
      // Cliff-lip exception: d=1 only when shooting down a cliff edge
      if (d === 1 && isCliffDown(unit.x, unit.z, e.x, e.z)) {
        set.add(key(e.x, e.z));
        continue;
      }
      // Archer: Chebyshev 2–3, LOS required (no flat adjacent)
      if (d < (unit.def.minRange || 2) || d > (unit.def.range || 3)) continue;
      if (!losClear(unit.x, unit.z, e.x, e.z, unit.faction)) continue;
      set.add(key(e.x, e.z));
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
  clearAttackPreviews();
}

function addHighlight(x, z, color, opacity = 0.45, opts = {}) {
  const p = worldPos(x, z);
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(TILE * 0.88, TILE * 0.88),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false })
  );
  m.rotation.x = -Math.PI / 2;
  m.position.set(p.x, tileHeight(x, z) + 0.2, p.z);
  highlightGroup.add(m);
  // Feel: high-ground attackable — cooler/brighter rim on the red plane (no enemy glyphs)
  if (opts.highGround) {
    const rim = new THREE.Mesh(
      new THREE.PlaneGeometry(TILE * 0.96, TILE * 0.96),
      new THREE.MeshBasicMaterial({
        color: 0xff9eb0,
        transparent: true,
        opacity: Math.min(0.85, opacity + 0.22),
        depthWrite: false,
      })
    );
    rim.rotation.x = -Math.PI / 2;
    rim.position.set(p.x, tileHeight(x, z) + 0.195, p.z);
    highlightGroup.add(rim);
  }
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
      const elev = (tileHeight(selected.x, selected.z) - tileHeight(x, z)) / HEIGHT_SPAN;
      if (elev > 0) addHighlight(x, z, 0xff6a88, 0.58, { highGround: true });
      else addHighlight(x, z, 0xff5d7a, 0.5);
    }
    showAttackPreviews(selected);
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
  const allies = countAdjacentAllies(selected);
  const formHud = allies >= 2 ? ' · ◆◆ form' : allies >= 1 ? ' · ◆ pair' : '';
  ui.unitInfo.innerHTML = `<strong>${selected.def.name}</strong> · HP ${selected.hp}/${selected.maxHp}<br>${canMove} · ${canAtk}${formHud}`;
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
  repositionAttackPreviews();
  if (waterMats.length) {
    const pulse = 0.08 + 0.04 * Math.sin(performance.now() / 900);
    for (const m of waterMats) m.emissiveIntensity = pulse;
  }
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
    if (n.includes('high')) {
      const m = n.match(/\+(\d+)%/);
      const pct = m ? m[1] : '4';
      chips.push({ cls: 'high', label: `▲ +${pct}%`, hud: '▲ high' });
    } else if (n.includes('formed')) chips.push({ cls: 'form', label: '◆◆ +8%', hud: '◆◆ form' });
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


function clearAttackPreviews() {
  for (const el of activeAttackPreviews.values()) {
    if (el.parentNode) el.parentNode.removeChild(el);
  }
  activeAttackPreviews.clear();
}

/** Formation preview chips on selected cyan only (high-ground = red highlight tint). */
function showAttackPreviews(attacker) {
  clearAttackPreviews();
  if (!attacker || attacker.hp <= 0 || attacker.attacked || phase !== 'player') return;
  if (!attacker.mesh) return;
  const layer = $('dmg-floats');
  if (!layer) return;
  // Attacker-side formation only — never put preview glyphs on idle enemies
  const allies = countAdjacentAllies(attacker);
  const notes = [];
  if (allies >= 2) notes.push('formed 3+ +8%');
  else if (allies >= 1) notes.push('paired +4%');
  const chips = bonusChips(notes);
  if (!chips.length) return;
  const el = document.createElement('div');
  el.className = 'dmg-float dmg-float-preview';
  const row = document.createElement('div');
  row.className = 'dmg-chips';
  for (const c of chips) {
    const span = document.createElement('span');
    span.className = `dmg-chip dmg-chip-preview ${c.cls}`;
    span.textContent = c.label;
    row.appendChild(span);
  }
  el.appendChild(row);
  const pos = attacker.mesh.position;
  const scr = worldToScreen(pos.x, pos.y + 0.85, pos.z);
  el.style.left = `${Math.round(scr.x)}px`;
  el.style.top = `${Math.round(scr.y)}px`;
  layer.appendChild(el);
  activeAttackPreviews.set(attacker, el);
}

function repositionAttackPreviews() {
  if (!activeAttackPreviews.size) return;
  for (const [unit, el] of activeAttackPreviews) {
    if (!unit || !unit.mesh || unit.hp <= 0) continue;
    const pos = unit.mesh.position;
    const scr = worldToScreen(pos.x, pos.y + 0.85, pos.z);
    el.style.left = `${Math.round(scr.x)}px`;
    el.style.top = `${Math.round(scr.y)}px`;
  }
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


function canRetaliate(unit) {
  return !!unit && (unit.type === 'infantry' || unit.type === 'bastion');
}

/** Clear once-per-phase retal budget for all living units (player phase + runAI entry). */
function clearRetaliationFlags() {
  for (const u of units) {
    if (u.hp > 0) u.retaliated = false;
  }
}

/**
 * Melee retaliation: defender hits attacker once if adjacent infantry/bastion and !retaliated.
 * Full normal damage pipeline; does not consume defender moved/attacked.
 */
function resolveRetaliation(attacker, defender) {
  if (!attacker || !defender) return false;
  if (defender.hp <= 0 || attacker.hp <= 0) return false;
  if (chebyshev(attacker.x, attacker.z, defender.x, defender.z) !== 1) return false;
  if (!canRetaliate(defender)) return false;
  if (defender.retaliated) return false;

  const { mult, notes } = attackMultiplier(defender, attacker);
  const retalNotes = notes.concat(['retaliation']);
  const raw = defender.def.atk + Math.floor(Math.random() * 2);
  const dmg = Math.max(1, Math.round(raw * mult));
  attacker.hp -= dmg;
  defender.retaliated = true;
  updateHpBar(attacker);
  flashCombat(defender, attacker, retalNotes);
  showDamageFloat(attacker, dmg, retalNotes);
  if (attacker.hp <= 0) {
    attacker.hp = 0;
    unitsGroup.remove(attacker.mesh);
    toast(`${attacker.def.name} destroyed!`, 1400);
    if (selected === attacker) {
      selected = null;
      clearHighlights();
    }
    return true;
  }
  return false;
}

function doAttack(attacker, defender) {
  if (attacker.attacked) return;
  clearAttackPreviews();
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
  } else {
    resolveRetaliation(attacker, defender);
  }
  updateIntelFromContact();
  refreshSelectionVisuals();
  updateHudCounts();
  updateUnitInfo();
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
  clearRetaliationFlags();
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
  // Fresh retal budget for the whole enemy phase (not per-faction mid-AI)
  clearRetaliationFlags();
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
    squad.sort((a, b) => b.def.range - a.def.range);
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

/** Full walkable flood (ignore units) — for river-region separation. */
function walkableRegion(sx, sz) {
  const seen = new Set();
  const q = [[sx, sz]];
  seen.add(key(sx, sz));
  while (q.length) {
    const [x, z] = q.shift();
    for (const [dx, dz] of DIRS8) {
      const nx = x + dx, nz = z + dz;
      if (!inBounds(nx, nz)) continue;
      const nk = key(nx, nz);
      if (seen.has(nk)) continue;
      const t = tileAt(nx, nz);
      if (!t || t.obstacle) continue;
      if (t.river && !t.bridge) continue;
      if (dx !== 0 && dz !== 0) {
        if (isCliffEdge(x, z, nx, z) || isCliffEdge(x, z, x, nz)) continue;
        if (isWater(nx, z) || isWater(x, nz)) continue;
      } else if (isCliffEdge(x, z, nx, nz)) {
        continue;
      }
      seen.add(nk);
      q.push([nx, nz]);
    }
  }
  return seen;
}

function isSeparatedByRiver(ux, uz, gx, gz) {
  if (!inBounds(gx, gz)) return false;
  const region = walkableRegion(ux, uz);
  return !region.has(key(gx, gz));
}

function nearestBridgeTile(ux, uz) {
  let best = null, bestD = Infinity;
  for (const t of tiles) {
    if (!t.bridge) continue;
    const d = chebyshev(ux, uz, t.x, t.z);
    if (d < bestD) {
      bestD = d;
      best = { x: t.x, z: t.z };
    }
  }
  return best;
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

  // River separation → funnel to closest bridge (to unit)
  if (isSeparatedByRiver(unit.x, unit.z, goalX, goalZ)) {
    const br = nearestBridgeTile(unit.x, unit.z);
    if (br) {
      goalX = br.x;
      goalZ = br.z;
    }
  }

  const mem = factionMemory[fac] || new Map();
  const hunting = !!hunt;
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
    // Archers hunting: prefer stop-short at 2–3 vs parking on goal footprint
    let archerBias = 0;
    if (unit.type === 'archer' && hunting && distGoal <= 1) archerBias = 1.5;
    const score = (hit ? ATTACK_BONUS : 0) + distGoal + archerBias + Math.random() * GOAL_NOISE;
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
  let retalKilledAttacker = false;
  if (defender.hp <= 0) {
    defender.hp = 0;
    unitsGroup.remove(defender.mesh);
  } else {
    retalKilledAttacker = resolveRetaliation(attacker, defender);
  }
  updateIntelFromContact();
  // Primary kills already trip checkWinLoseEarly after aiAct; retal-kill needs an explicit check.
  if (retalKilledAttacker) checkWinLose();
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

/** Persistent version proof in battle HUD (not session-gated / not timed). */
if (ui.buildChip) ui.buildChip.textContent = BUILD_ID;

/** QA: ?fresh=1 (also ?swtoast=1 / ?swcheck=1) clears banner gate and forces toast once. */
function qaForceVersionProof() {
  let params;
  try { params = new URLSearchParams(location.search); } catch (_) { return false; }
  if (!(params.has('fresh') || params.has('swtoast') || params.has('swcheck'))) return false;
  try { sessionStorage.removeItem('gf-build-shown'); } catch (_) { /* private mode */ }
  showBuildBannerOnce();
  promptSwUpdate();
  return true;
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const qaForced = qaForceVersionProof();
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
        if (!qaForced) showBuildBannerOnce();
      })
      .catch(() => {});

    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return;
      refreshing = true;
      toast('Updated — hard-refresh if the board looks stale', 4200);
    });
  });
} else {
  window.addEventListener('load', () => { qaForceVersionProof(); });
}
