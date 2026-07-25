import { GRID_W, GRID_H, CELL_COUNT } from './config.js';

/**
 * Breadth-first flow field over the level grid.
 *
 * One BFS gives EVERY cell its step-distance to the player, so the entity's
 * per-frame "where do I go" query is a 4-neighbour comparison — O(1) — instead
 * of an A* search per agent per tick. Adding more entities costs nothing extra.
 *
 * Both working buffers are allocated once at module scope and reused for the
 * life of the tab. `dist` is refilled with a sentinel rather than reallocated.
 */

const DIST = new Int32Array(CELL_COUNT);
const QUEUE = new Int32Array(CELL_COUNT);
const UNREACHED = 0x7fffffff;

let lastTarget = -1;

export function getDistance(cell) {
  return DIST[cell];
}

export function flowTarget() {
  return lastTarget;
}

/**
 * Recomputes the field toward `targetCell`. Cheap enough (~3.7k cells) to run
 * a few times a second; callers must still gate it on the target actually
 * having moved to a new cell.
 */
export function computeFlow(grid, targetCell) {
  if (targetCell === lastTarget) return false;
  lastTarget = targetCell;

  DIST.fill(UNREACHED);
  DIST[targetCell] = 0;

  let head = 0;
  let tail = 0;
  QUEUE[tail++] = targetCell;

  while (head < tail) {
    const c = QUEUE[head++];
    const d = DIST[c] + 1;
    const cx = c % GRID_W;
    const cy = (c / GRID_W) | 0;

    if (cx > 0) { const n = c - 1; if (grid[n] === 0 && DIST[n] === UNREACHED) { DIST[n] = d; QUEUE[tail++] = n; } }
    if (cx < GRID_W - 1) { const n = c + 1; if (grid[n] === 0 && DIST[n] === UNREACHED) { DIST[n] = d; QUEUE[tail++] = n; } }
    if (cy > 0) { const n = c - GRID_W; if (grid[n] === 0 && DIST[n] === UNREACHED) { DIST[n] = d; QUEUE[tail++] = n; } }
    if (cy < GRID_H - 1) { const n = c + GRID_W; if (grid[n] === 0 && DIST[n] === UNREACHED) { DIST[n] = d; QUEUE[tail++] = n; } }
  }
  return true;
}

// Out-params for the descent query (see collision.js for the same pattern).
export let stepCX = 0;
export let stepCY = 0;
export let stepFound = false;

/** Picks the neighbouring cell with the lowest distance-to-target. */
export function descend(grid, cx, cy) {
  stepFound = false;
  const here = cy * GRID_W + cx;
  let best = DIST[here];
  if (best === UNREACHED) {
    // Off-field (entity got sealed in): fall back to any open neighbour.
    best = UNREACHED;
  }

  let bx = cx;
  let by = cy;

  if (cx > 0 && grid[here - 1] === 0 && DIST[here - 1] < best) { best = DIST[here - 1]; bx = cx - 1; by = cy; }
  if (cx < GRID_W - 1 && grid[here + 1] === 0 && DIST[here + 1] < best) { best = DIST[here + 1]; bx = cx + 1; by = cy; }
  if (cy > 0 && grid[here - GRID_W] === 0 && DIST[here - GRID_W] < best) { best = DIST[here - GRID_W]; bx = cx; by = cy - 1; }
  if (cy < GRID_H - 1 && grid[here + GRID_W] === 0 && DIST[here + GRID_W] < best) { best = DIST[here + GRID_W]; bx = cx; by = cy + 1; }

  if (bx !== cx || by !== cy) {
    stepCX = bx;
    stepCY = by;
    stepFound = true;
  }
  return stepFound;
}

export function resetFlow() {
  lastTarget = -1;
}
