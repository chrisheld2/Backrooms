import {
  GRID_W, GRID_H, CELL, HALF_W, HALF_H, RISE, STEP_UP, PROP_RADIUS,
} from './config.js';

/**
 * Grid collision. O(9) per query, zero allocation, zero raycasts.
 *
 * Deliberately NOT three-mesh-bvh: a BVH over the merged wall mesh would cost
 * ~1 MB of node arrays and a log-n descent per query to answer a question the
 * uniform grid answers with two integer divides. BVH is the right call for
 * arbitrary/streamed geometry; here the world IS a uniform grid, so the grid
 * itself is the acceleration structure.
 *
 * Verticality rides along for free. A cell obstructs a mover if it is solid OR
 * if its floor stands more than STEP_UP above the mover's feet — so the lip of
 * a mezzanine, the side of a split-level and a wall are all the same test, and
 * a drop-off is one-way without a single special case: walking off it is
 * unobstructed (the target floor is below), walking back up is not.
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

/**
 * World-space floor elevation under a point.
 *
 * Flat cells resolve to a single multiply. On a connector the floor is the
 * plane between the cell's two edge elevations, sampled along the uphill axis —
 * so a staircase is *walked* as a continuous incline even though it is *drawn*
 * as discrete treads. That split is deliberate: stepped collision would make
 * the camera stutter up every riser, and nobody has ever wanted that.
 */
export function floorYAt(level, x, z) {
  const gx = ((x / CELL) + HALF_W) | 0;
  const gy = ((z / CELL) + HALF_H) | 0;
  if (gx < 0 || gy < 0 || gx >= GRID_W || gy >= GRID_H) return 0;
  const c = gy * GRID_W + gx;

  const rise = level.slopeRise[c];
  const base = level.heights[c];
  if (rise === 0) return base * RISE;

  const up = level.slopeDir[c];
  let t;
  if (up === 1) t = (x / CELL) + HALF_W - gx; // +X
  else if (up === 2) t = 1 - ((x / CELL) + HALF_W - gx); // -X
  else if (up === 3) t = (z / CELL) + HALF_H - gy; // +Z
  else t = 1 - ((z / CELL) + HALF_H - gy); // -Z

  if (t < 0) t = 0; else if (t > 1) t = 1;
  return (base + rise * t) * RISE;
}

/** Ceiling elevation over a point, for headroom checks. */
export function ceilYAt(level, x, z) {
  const gx = ((x / CELL) + HALF_W) | 0;
  const gy = ((z / CELL) + HALF_H) | 0;
  if (gx < 0 || gy < 0 || gx >= GRID_W || gy >= GRID_H) return 0;
  const c = gy * GRID_W + gx;
  return floorYAt(level, x, z) + level.headroom[c];
}

/**
 * Is this cell an obstacle for a mover whose feet are at `feetY`?
 *
 * The comparison uses the cell's *downhill* elevation, which is its minimum.
 * That is the permissive choice, and it is safe only because connector runs are
 * walled along their flanks at generation time: a slope can be entered at its
 * ends and nowhere else, so its low edge is the only edge a mover can meet.
 */
function blocks(level, gx, gy, feetY) {
  if (gx < 0 || gy < 0 || gx >= GRID_W || gy >= GRID_H) return true;
  const c = gy * GRID_W + gx;
  if (level.grid[c] === 1) return true;
  return level.heights[c] * RISE - feetY > STEP_UP;
}

/**
 * Slides a circle of `radius` out of anything it overlaps — walls, unclimbable
 * floor edges, and furniture. Writes the corrected position to `hitX`/`hitZ`.
 */
export function resolveCircle(level, x, z, radius, feetY) {
  hitWall = false;
  let px = x;
  let pz = z;
  const grid = level.grid;
  const props = level.props;

  // Two relaxation passes settle inside-corner cases cleanly.
  for (let pass = 0; pass < 2; pass++) {
    const cx = ((px / CELL) + HALF_W) | 0;
    const cy = ((pz / CELL) + HALF_H) | 0;

    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const gx = cx + ox;
        const gy = cy + oy;

        if (blocks(level, gx, gy, feetY)) {
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

          if (d2 <= radius * radius) {
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
          continue;
        }

        // Open cell: it may still hold one piece of furniture.
        if (gx < 0 || gy < 0 || gx >= GRID_W || gy >= GRID_H) continue;
        const pi = props.at[gy * GRID_W + gx];
        if (pi < 0) continue;
        const pr = PROP_RADIUS[props.type[pi]];
        if (pr <= 0) continue;

        const dx = px - props.x[pi];
        const dz = pz - props.z[pi];
        const rr = pr + radius;
        const d2 = dx * dx + dz * dz;
        if (d2 >= rr * rr) continue;
        hitWall = true;
        if (d2 > 1e-8) {
          const d = Math.sqrt(d2);
          const push = rr - d;
          px += (dx / d) * push;
          pz += (dz / d) * push;
        } else {
          px += rr;
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
 *
 * Purely horizontal: a mezzanine railing does not occlude, so the entity can
 * see you across an open drop. Callers gate on vertical separation themselves.
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
