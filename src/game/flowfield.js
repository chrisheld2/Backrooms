import { GRID_W, CELL_COUNT } from './config.js';
import { DIR_OFF, DIR_OPP } from './maze.js';

/**
 * Breadth-first flow field over the level grid.
 *
 * One BFS gives EVERY cell its step-distance to the player, so the entity's
 * per-frame "where do I go" query is a 4-neighbour comparison — O(1) — instead
 * of an A* search per agent per tick. Adding more entities costs nothing extra.
 *
 * The field is DIRECTED. It expands over the baked passability mask, and
 * because the search runs outward from the player while the entity walks
 * inward, each expansion is tested in the direction the entity would actually
 * travel — the reverse of the one the BFS is moving. Get that backwards and the
 * entity happily paths up the face of a drop-off it can never climb, then jams
 * against it forever.
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
 *
 * @param {Uint8Array} pass per-cell 4-bit step mask from buildPassMask
 */
export function computeFlow(pass, targetCell) {
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

    for (let dir = 1; dir <= 4; dir++) {
      const n = c + DIR_OFF[dir];
      if (n < 0 || n >= CELL_COUNT) continue;
      if (DIST[n] !== UNREACHED) continue;
      // Can a mover standing on n step to c? The mask already encodes both
      // solidity and the row-wrap guard, so nothing else needs checking.
      if ((pass[n] & (1 << (DIR_OPP[dir] - 1))) === 0) continue;
      DIST[n] = d;
      QUEUE[tail++] = n;
    }
  }
  return true;
}

// Out-params for the descent query (see collision.js for the same pattern).
export let stepCX = 0;
export let stepCY = 0;
export let stepFound = false;

/** Picks the reachable neighbour with the lowest distance-to-target. */
export function descend(pass, cx, cy) {
  stepFound = false;
  const here = cy * GRID_W + cx;
  const mask = pass[here];
  let best = DIST[here];

  let bx = cx;
  let by = cy;

  for (let dir = 1; dir <= 4; dir++) {
    if ((mask & (1 << (dir - 1))) === 0) continue;
    const n = here + DIR_OFF[dir];
    if (DIST[n] >= best) continue;
    best = DIST[n];
    bx = n % GRID_W;
    by = (n / GRID_W) | 0;
  }

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
