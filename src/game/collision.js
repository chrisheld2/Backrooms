import { GRID_W, GRID_H, CELL, HALF_W, HALF_H } from './config.js';

/**
 * Grid collision. O(9) per query, zero allocation, zero raycasts.
 *
 * Deliberately NOT three-mesh-bvh: a BVH over the merged wall mesh would cost
 * ~1 MB of node arrays and a log-n descent per query to answer a question the
 * uniform grid answers with two integer divides. BVH is the right call for
 * arbitrary/streamed geometry; here the world IS a uniform grid, so the grid
 * itself is the acceleration structure.
 *
 * Results are returned via module-scoped out-params rather than an object
 * literal — callers read `hitX` / `hitZ` immediately after the call.
 */

export let hitX = 0;
export let hitZ = 0;
export let hitWall = false;

export function isSolid(grid, cx, cy) {
  if (cx < 0 || cy < 0 || cx >= GRID_W || cy >= GRID_H) return true;
  return grid[cy * GRID_W + cx] === 1;
}

export function isSolidWorld(grid, x, z) {
  return isSolid(grid, ((x / CELL) + HALF_W) | 0, ((z / CELL) + HALF_H) | 0);
}

/** Height tier (0..MAX_LEVEL, in LEVEL_STEP units — not world units) at a world position. */
export function heightTierAt(heights, x, z) {
  const cx = ((x / CELL) + HALF_W) | 0;
  const cy = ((z / CELL) + HALF_H) | 0;
  if (cx < 0 || cy < 0 || cx >= GRID_W || cy >= GRID_H) return 0;
  return heights[cy * GRID_W + cx];
}

/**
 * Slides a circle of `radius` out of any solid cell it overlaps.
 * Writes the corrected position to `hitX` / `hitZ`.
 */
export function resolveCircle(grid, x, z, radius) {
  hitWall = false;
  let px = x;
  let pz = z;

  // Two relaxation passes settle inside-corner cases cleanly.
  for (let pass = 0; pass < 2; pass++) {
    const cx = ((px / CELL) + HALF_W) | 0;
    const cy = ((pz / CELL) + HALF_H) | 0;

    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const gx = cx + ox;
        const gy = cy + oy;
        if (!isSolid(grid, gx, gy)) continue;

        const minX = (gx - HALF_W) * CELL;
        const maxX = minX + CELL;
        const minZ = (gy - HALF_H) * CELL;
        const maxZ = minZ + CELL;

        // Closest point on the cell AABB to the circle centre.
        const nx = px < minX ? minX : px > maxX ? maxX : px;
        const nz = pz < minZ ? minZ : pz > maxZ ? maxZ : pz;

        let dx = px - nx;
        let dz = pz - nz;
        const d2 = dx * dx + dz * dz;

        if (d2 > radius * radius) continue;
        hitWall = true;

        if (d2 > 1e-8) {
          const d = Math.sqrt(d2);
          const push = radius - d;
          px += (dx / d) * push;
          pz += (dz / d) * push;
        } else {
          // Centre is inside the box: eject along the shallowest axis.
          const toL = px - minX;
          const toR = maxX - px;
          const toB = pz - minZ;
          const toT = maxZ - pz;
          const m = Math.min(toL, toR, toB, toT);
          if (m === toL) px = minX - radius;
          else if (m === toR) px = maxX + radius;
          else if (m === toB) pz = minZ - radius;
          else pz = maxZ + radius;
        }
      }
    }
  }

  hitX = px;
  hitZ = pz;
}

/**
 * Grid-marched line of sight (Amanatides & Woo DDA). Integer stepping only —
 * no Raycaster, no Vector3, no intersection arrays.
 */
export function hasLineOfSight(grid, x0, z0, x1, z1, maxDist) {
  let dx = x1 - x0;
  let dz = z1 - z0;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist > maxDist) return false;
  if (dist < 1e-4) return true;
  dx /= dist;
  dz /= dist;

  let cx = ((x0 / CELL) + HALF_W) | 0;
  let cy = ((z0 / CELL) + HALF_H) | 0;
  const endX = ((x1 / CELL) + HALF_W) | 0;
  const endY = ((z1 / CELL) + HALF_H) | 0;

  const stepX = dx > 0 ? 1 : -1;
  const stepZ = dz > 0 ? 1 : -1;
  const tDeltaX = dx !== 0 ? Math.abs(CELL / dx) : Infinity;
  const tDeltaZ = dz !== 0 ? Math.abs(CELL / dz) : Infinity;

  const boundX = (cx - HALF_W + (stepX > 0 ? 1 : 0)) * CELL;
  const boundZ = (cy - HALF_H + (stepZ > 0 ? 1 : 0)) * CELL;
  let tMaxX = dx !== 0 ? (boundX - x0) / dx : Infinity;
  let tMaxZ = dz !== 0 ? (boundZ - z0) / dz : Infinity;

  let guard = 0;
  while (guard++ < 256) {
    if (cx === endX && cy === endY) return true;
    if (tMaxX < tMaxZ) { cx += stepX; tMaxX += tDeltaX; }
    else { cy += stepZ; tMaxZ += tDeltaZ; }
    if (isSolid(grid, cx, cy)) return false;
  }
  return false;
}
