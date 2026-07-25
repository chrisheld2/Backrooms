import { GRID_W, GRID_H, CELL_COUNT } from './config.js';

/**
 * Level 0 layout generator.
 *
 * Data-oriented: the level is one flat Uint8Array (1 = solid, 0 = open). Every
 * downstream system (collision, pathing, lamp placement, spawn selection) reads
 * this same buffer, so there is exactly one source of truth and no per-cell
 * object graph to walk or garbage collect.
 *
 * Generation runs ONCE per run at mount time — allocations here are fine and
 * deliberate. Nothing in this file may be called from a frame loop.
 */

/** Deterministic 32-bit PRNG (mulberry32). Seeded runs => reproducible levels. */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const idx = (cx, cy) => cy * GRID_W + cx;

/**
 * @returns {{grid: Uint8Array, openCells: Int32Array, spawn: number, rng: Function}}
 */
export function generateLevel(seed) {
  const rng = makeRng(seed);
  const grid = new Uint8Array(CELL_COUNT).fill(1);

  // --- 1. Perfect maze on odd cells (iterative DFS; no recursion, no closures)
  const stack = new Int32Array(CELL_COUNT);
  let sp = 0;

  const startX = 1;
  const startY = 1;
  grid[idx(startX, startY)] = 0;
  stack[sp++] = idx(startX, startY);

  // Scratch for the 4 candidate neighbours; reused across the whole carve.
  const candX = new Int32Array(4);
  const candY = new Int32Array(4);

  while (sp > 0) {
    const cur = stack[sp - 1];
    const cx = cur % GRID_W;
    const cy = (cur / GRID_W) | 0;

    let n = 0;
    if (cy - 2 >= 1 && grid[idx(cx, cy - 2)] === 1) { candX[n] = cx; candY[n] = cy - 2; n++; }
    if (cy + 2 < GRID_H - 1 && grid[idx(cx, cy + 2)] === 1) { candX[n] = cx; candY[n] = cy + 2; n++; }
    if (cx - 2 >= 1 && grid[idx(cx - 2, cy)] === 1) { candX[n] = cx - 2; candY[n] = cy; n++; }
    if (cx + 2 < GRID_W - 1 && grid[idx(cx + 2, cy)] === 1) { candX[n] = cx + 2; candY[n] = cy; n++; }

    if (n === 0) { sp--; continue; }

    const pick = (rng() * n) | 0;
    const nx = candX[pick];
    const ny = candY[pick];
    grid[idx((cx + nx) >> 1, (cy + ny) >> 1)] = 0; // knock out the wall between
    grid[idx(nx, ny)] = 0;
    stack[sp++] = idx(nx, ny);
  }

  // --- 2. Braiding: remove ~34% of remaining interior walls.
  // A perfect maze reads as a puzzle; the Backrooms should read as an endless,
  // loop-riddled office floor where every turn looks like the last one.
  for (let cy = 1; cy < GRID_H - 1; cy++) {
    for (let cx = 1; cx < GRID_W - 1; cx++) {
      const i = idx(cx, cy);
      if (grid[i] === 0) continue;
      if (rng() < 0.34) grid[i] = 0;
    }
  }

  // --- 3. Blow out open rooms.
  const roomCount = 16;
  for (let r = 0; r < roomCount; r++) {
    const w = 3 + ((rng() * 6) | 0);
    const h = 3 + ((rng() * 6) | 0);
    const ox = 1 + ((rng() * (GRID_W - 2 - w)) | 0);
    const oy = 1 + ((rng() * (GRID_H - 2 - h)) | 0);
    for (let y = oy; y < oy + h; y++) {
      for (let x = ox; x < ox + w; x++) grid[idx(x, y)] = 0;
    }
  }

  // --- 4. Scatter freestanding pillars/stubs back in for visual noise.
  for (let cy = 2; cy < GRID_H - 2; cy++) {
    for (let cx = 2; cx < GRID_W - 2; cx++) {
      const i = idx(cx, cy);
      if (grid[i] === 1) continue;
      if (rng() < 0.014) grid[i] = 1;
    }
  }

  // --- 5. Hard border.
  for (let x = 0; x < GRID_W; x++) {
    grid[idx(x, 0)] = 1;
    grid[idx(x, GRID_H - 1)] = 1;
  }
  for (let y = 0; y < GRID_H; y++) {
    grid[idx(0, y)] = 1;
    grid[idx(GRID_W - 1, y)] = 1;
  }

  // --- 6. Flood fill from the spawn cell, keep only the reachable component.
  // Anything the player can never touch gets filled back in: fewer wall quads,
  // and pathing/pickup placement can never target an unreachable cell.
  const spawn = pickCentralOpen(grid, rng);
  const reachable = new Uint8Array(CELL_COUNT);
  const queue = new Int32Array(CELL_COUNT);
  let qh = 0;
  let qt = 0;
  queue[qt++] = spawn;
  reachable[spawn] = 1;
  while (qh < qt) {
    const c = queue[qh++];
    const cx = c % GRID_W;
    const cy = (c / GRID_W) | 0;
    if (cx > 0) { const n = c - 1; if (!reachable[n] && grid[n] === 0) { reachable[n] = 1; queue[qt++] = n; } }
    if (cx < GRID_W - 1) { const n = c + 1; if (!reachable[n] && grid[n] === 0) { reachable[n] = 1; queue[qt++] = n; } }
    if (cy > 0) { const n = c - GRID_W; if (!reachable[n] && grid[n] === 0) { reachable[n] = 1; queue[qt++] = n; } }
    if (cy < GRID_H - 1) { const n = c + GRID_W; if (!reachable[n] && grid[n] === 0) { reachable[n] = 1; queue[qt++] = n; } }
  }
  for (let i = 0; i < CELL_COUNT; i++) if (grid[i] === 0 && reachable[i] === 0) grid[i] = 1;

  const openCells = queue.slice(0, qt); // exactly the reachable open set

  const { heights, rampCells } = assignHeights(grid, openCells, rng, spawn);

  return { grid, openCells, spawn, rng, heights, rampCells };
}

/**
 * Raised/lowered platform blobs, layered outward from a core cell by BFS depth
 * so every step between two adjacent cells is exactly one tier — no cliff a
 * player could clip through, no gap that needs bookkeeping beyond "look at the
 * neighbour's height". Each blob is independently styled: `rampCells` marks a
 * blob's transition ring as a smooth incline instead of the default stepped
 * riser, so the level reads as "stairs, sometimes ramps" rather than uniform.
 *
 * Runs once at level-generation time; the Map/array use here is deliberate and
 * fine (see file header) — nothing here executes per frame.
 */
function assignHeights(grid, openCells, rng, spawn) {
  const heights = new Uint8Array(CELL_COUNT);
  const rampCells = new Uint8Array(CELL_COUNT);
  const claimed = new Uint8Array(CELL_COUNT);
  const MARGIN = 3;
  // Dense enough that a normal exploring player crosses a platform within the
  // first minute or two, not just somewhere on the far side of the map.
  const blobCount = 16 + ((rng() * 10) | 0);
  const sx = spawn % GRID_W;
  const sy = (spawn / GRID_W) | 0;

  for (let b = 0; b < blobCount; b++) {
    // The first few blobs are steered into a ring around spawn (not on top of
    // it, not clear across the map) so verticality shows up early.
    const wantNear = b < 4;
    let core = -1;
    for (let t = 0; t < 50; t++) {
      const c = openCells[(rng() * openCells.length) | 0];
      const cx = c % GRID_W;
      const cy = (c / GRID_W) | 0;
      if (cx < MARGIN || cy < MARGIN || cx >= GRID_W - MARGIN || cy >= GRID_H - MARGIN) continue;
      if (claimed[c]) continue;
      if (wantNear) {
        const d = Math.abs(cx - sx) + Math.abs(cy - sy);
        if (d < 5 || d > 20) continue;
      }
      core = c;
      break;
    }
    if (core < 0) continue;

    const maxLevel = rng() < 0.3 ? 2 : 1;
    const rampStyle = rng() < 0.5;
    // Plateau radius: how many BFS rings share one height tier before stepping
    // down. Without this, only the single core cell would ever sit at the top
    // tier (BFS depth 0 is one cell) — plateaus need a multi-ring band per tier.
    const plateauRadius = 2 + ((rng() * 2) | 0);
    const cellBudget = maxLevel === 2 ? 44 : 26;

    const queue = [core];
    const dist = new Map([[core, 0]]);
    let qi = 0;
    let claimedCount = 0;

    while (qi < queue.length && claimedCount < cellBudget) {
      const c = queue[qi++];
      const d = dist.get(c);
      const h = maxLevel - Math.floor(d / plateauRadius);
      if (h <= 0) continue;

      heights[c] = h;
      if (rampStyle) rampCells[c] = 1;
      claimed[c] = 1;
      claimedCount++;

      const cx = c % GRID_W;
      const cy = (c / GRID_W) | 0;
      const neighbors = [];
      if (cx + 1 < GRID_W - MARGIN) neighbors.push(c + 1);
      if (cx - 1 >= MARGIN) neighbors.push(c - 1);
      if (cy + 1 < GRID_H - MARGIN) neighbors.push(c + GRID_W);
      if (cy - 1 >= MARGIN) neighbors.push(c - GRID_W);

      for (const n of neighbors) {
        if (grid[n] !== 0) continue;
        if (claimed[n] || dist.has(n)) continue;
        dist.set(n, d + 1);
        queue.push(n);
      }
    }
  }

  return { heights, rampCells };
}

function pickCentralOpen(grid, rng) {
  const cx0 = GRID_W >> 1;
  const cy0 = GRID_H >> 1;
  for (let radius = 0; radius < GRID_W; radius++) {
    for (let t = 0; t < 24; t++) {
      const cx = clamp(cx0 + ((rng() * (radius * 2 + 1)) | 0) - radius, 1, GRID_W - 2);
      const cy = clamp(cy0 + ((rng() * (radius * 2 + 1)) | 0) - radius, 1, GRID_H - 2);
      if (grid[idx(cx, cy)] === 0) return idx(cx, cy);
    }
  }
  return idx(1, 1);
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Picks `count` open cells that are mutually far apart and at least `minDist`
 * cells from `fromCell`. Used for pickups, the exit and the entity spawn.
 * Init-time only.
 */
export function pickSpreadCells(grid, openCells, rng, count, fromCell, minDist) {
  const fx = fromCell % GRID_W;
  const fy = (fromCell / GRID_W) | 0;
  const out = new Int32Array(count);
  let found = 0;
  let guard = 0;
  const minSep = Math.max(6, ((GRID_W + GRID_H) / (count * 2)) | 0);

  while (found < count && guard++ < 40000) {
    const c = openCells[(rng() * openCells.length) | 0];
    const cx = c % GRID_W;
    const cy = (c / GRID_W) | 0;
    if (Math.abs(cx - fx) + Math.abs(cy - fy) < minDist) continue;

    let ok = true;
    for (let i = 0; i < found; i++) {
      const o = out[i];
      const ox = o % GRID_W;
      const oy = (o / GRID_W) | 0;
      if (Math.abs(cx - ox) + Math.abs(cy - oy) < minSep) { ok = false; break; }
    }
    if (!ok) continue;
    out[found++] = c;
  }
  // Degenerate fallback: pad with any open cell.
  while (found < count) out[found++] = openCells[(rng() * openCells.length) | 0];
  return out;
}
