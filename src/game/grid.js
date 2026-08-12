import { GRID_W } from './config.js';

/**
 * Cell-space primitives: the vocabulary every other module speaks.
 *
 * This exists to sit UNDER both the plan (maze.js) and the section
 * (ceiling.js). Those two genuinely need each other's terms — the ceiling is
 * defined against the floor, and the floor plan decides where the ceiling
 * zones go — and expressing that as a direct import cycle worked in a Rollup
 * production build but broke under Vite's dev transform. One shared base
 * module removes the cycle instead of relying on a bundler to tolerate it.
 *
 * maze.js re-exports everything here, so existing call sites are unaffected.
 */

// ---- Directions -------------------------------------------------------------
export const DIR_PX = 1;
export const DIR_NX = 2;
export const DIR_PZ = 3;
export const DIR_NZ = 4;

/** Cell-index delta for each direction. Index 0 is unused padding. */
export const DIR_OFF = [0, 1, -1, GRID_W, -GRID_W];
export const DIR_OPP = [0, DIR_NX, DIR_PX, DIR_NZ, DIR_PZ];
export const DIR_DX = [0, 1, -1, 0, 0];
export const DIR_DY = [0, 0, 0, 1, -1];

/** Guards the ±1 horizontal steps against wrapping across a row boundary. */
export function sameRow(c, n, dir) {
  if (dir === DIR_PX) return (n % GRID_W) === (c % GRID_W) + 1;
  if (dir === DIR_NX) return (n % GRID_W) === (c % GRID_W) - 1;
  return true;
}

// ---- Connector classification ------------------------------------------------
export const CONN_FLAT = 0;
export const CONN_STAIR = 1;
export const CONN_RAMP = 2;

// ---- Floor sampling ----------------------------------------------------------

/**
 * Floor elevation, in hu, at corner `i` of `cell`, where the corners run
 * A,B,C,D = (x0,z0) (x1,z0) (x1,z1) (x0,z1).
 *
 * Flat cells give four equal values; a connector puts its two uphill corners a
 * full `slopeRise` above the other two. Everything that has to meet the floor —
 * wall quads, the ceiling above it, the collision sampler — reads it from here,
 * so there is one definition of where the floor is and nothing can disagree
 * with it by a rounding error.
 */
export function cornerHu(heights, slopeDir, slopeRise, cell, i) {
  const base = heights[cell];
  const rise = slopeRise[cell];
  if (rise === 0) return base;
  switch (slopeDir[cell]) {
    case DIR_PX: return i === 1 || i === 2 ? base + rise : base;
    case DIR_NX: return i === 0 || i === 3 ? base + rise : base;
    case DIR_PZ: return i === 2 || i === 3 ? base + rise : base;
    default: return i === 0 || i === 1 ? base + rise : base;
  }
}

/**
 * Floor elevation, in hu, at the edge of `cell` facing `dir`.
 *
 * This is the join primitive the vertical system rests on: two cells connect
 * cleanly iff the edge heights they present to each other match. A stair's
 * treads and its landing agree exactly because both sides evaluate to the same
 * integer, not because they landed within some tolerance.
 */
export function edgeHu(heights, slopeDir, slopeRise, cell, dir) {
  const rise = slopeRise[cell];
  const base = heights[cell];
  if (rise === 0) return base;
  const up = slopeDir[cell];
  if (dir === up) return base + rise;
  if (dir === DIR_OPP[up]) return base;
  return base + (rise >> 1); // crossing a slope sideways: meet it mid-cell
}
