import * as THREE from 'three';
import {
  GRID_W, GRID_H, CELL, HALF_W, HALF_H, TEX_SCALE, TEX_SCALE_HARD,
  RISE, STAIR_TREADS, Z_LOWER,
} from './config.js';
import { idx, CONN_FLAT, CONN_STAIR, DIR_PX, DIR_NX, DIR_PZ, DIR_NZ } from './maze.js';

/**
 * Builds the entire static level shell as buffer geometries.
 *
 * Why hand-rolled buffers instead of N boxGeometries + mergeGeometries():
 *  - Only faces that border an open cell (or a height change) are emitted. A
 *    merge of full boxes would ship ~6x the triangles, most of them
 *    permanently buried inside solid wall runs where no camera can ever see
 *    them.
 *  - No intermediate Mesh/Geometry objects are created and thrown away, so the
 *    load spike is one pass over the grid instead of thousands of allocations.
 *
 * Four buffers, four draw calls, for a whole three-storey building:
 *
 *   floor    carpet, flat cells on the office and mezzanine strata
 *   hard     concrete: stair treads and risers, ramps, and the whole
 *            maintenance level's floor. Routing Lower Maintenance here rather
 *            than tinting carpet grey gives that stratum a genuinely different
 *            surface for free — the material was already being paid for.
 *   wall     every vertical face: wall faces, drop-off cliffs, ceiling
 *            bulkheads where headroom changes between strata
 *   ceiling  per-cell, following each stratum's own headroom, raked over
 *            connector shafts
 *
 * All elevation comes from four corner heights per cell (see cornerHu). Every
 * quad is emitted from those corners, so a flat floor, a raked stair soffit and
 * the trapezoid where a wall meets the side of a flight are all the same code
 * path and none of them can leave a crack.
 */

const AO_FLOOR = 0.34; // vertex brightness at the base of a wall
const AO_TOP = 1.0;

/** Per-stratum surface tint, multiplied into the baked AO gradient. */
const ZONE_TINT = [0.72, 1.0, 0.92];

// --- Quad staging. Module-scoped so the emitters take a readable arg list
// instead of 27 positional parameters. Init-time only; never touched per frame.
const _qx = new Float64Array(4);
const _qy = new Float64Array(4);
const _qz = new Float64Array(4);
const _qu = new Float64Array(4);
const _qv = new Float64Array(4);
const _qs = new Float64Array(4);

function setCorner(i, x, y, z, u, v, s) {
  _qx[i] = x; _qy[i] = y; _qz[i] = z; _qu[i] = u; _qv[i] = v; _qs[i] = s;
}

/** Counts quads on the first pass so the typed arrays are sized exactly once. */
function countingSink() {
  let n = 0;
  return {
    counting: true,
    push() { n++; },
    get count() { return n; },
  };
}

/** Writes quads as two non-indexed triangles: A B C, A C D. */
function bufferSink(quadCount, withColor) {
  const vertCount = quadCount * 6;
  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const colors = withColor ? new Float32Array(vertCount * 3) : null;
  let p = 0;
  let n = 0;
  let u = 0;
  let c = 0;

  function vert(i, nx, ny, nz) {
    positions[p++] = _qx[i]; positions[p++] = _qy[i]; positions[p++] = _qz[i];
    normals[n++] = nx; normals[n++] = ny; normals[n++] = nz;
    uvs[u++] = _qu[i]; uvs[u++] = _qv[i];
    if (colors) { colors[c++] = _qs[i]; colors[c++] = _qs[i]; colors[c++] = _qs[i]; }
  }

  return {
    counting: false,
    push(nx, ny, nz) {
      vert(0, nx, ny, nz); vert(1, nx, ny, nz); vert(2, nx, ny, nz);
      vert(0, nx, ny, nz); vert(2, nx, ny, nz); vert(3, nx, ny, nz);
    },
    build() {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
      if (colors) geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geo.computeBoundingSphere();
      return geo;
    },
  };
}

/**
 * The four corner elevations of a cell's floor, in hu, as [A,B,C,D] =
 * [(x0,z0), (x1,z0), (x1,z1), (x0,z1)].
 *
 * Flat cells give four equal values. A connector gives its two low corners at
 * `heights[c]` and its two high corners a full `slopeRise` above — which is
 * what lets a wall standing alongside a flight be emitted as the exact
 * trapezoid it needs to be rather than a rectangle with a gap under it.
 */
const _corner = new Int32Array(4);
function cornerHu(level, c) {
  const base = level.heights[c];
  const rise = level.slopeRise[c];
  if (rise === 0) {
    _corner[0] = base; _corner[1] = base; _corner[2] = base; _corner[3] = base;
    return _corner;
  }
  const hi = base + rise;
  switch (level.slopeDir[c]) {
    case DIR_PX: _corner[0] = base; _corner[1] = hi; _corner[2] = hi; _corner[3] = base; break;
    case DIR_NX: _corner[0] = hi; _corner[1] = base; _corner[2] = base; _corner[3] = hi; break;
    case DIR_PZ: _corner[0] = base; _corner[1] = base; _corner[2] = hi; _corner[3] = hi; break;
    default: _corner[0] = hi; _corner[1] = hi; _corner[2] = base; _corner[3] = base; break;
  }
  return _corner;
}

/**
 * Corner indices [first, second] bounding the edge on each side of a cell,
 * ordered so that emitting them low-to-high winds counter-clockwise as seen
 * from that face's outward normal.
 */
const EDGE_CORNERS = [[], [2, 1], [0, 3], [3, 2], [1, 0]];
/** Outward normal per direction. */
const NORM_X = [0, 1, -1, 0, 0];
const NORM_Z = [0, 0, 0, 1, -1];

// Cached corner reads, so a neighbour lookup does not clobber the current cell.
const _cornerA = new Int32Array(4);
const _cornerB = new Int32Array(4);

function readCorners(level, c, out) {
  const src = cornerHu(level, c);
  out[0] = src[0]; out[1] = src[1]; out[2] = src[2]; out[3] = src[3];
  return out;
}

/** World-space X/Z of a cell corner index. */
function cornerX(cx, i) {
  const x0 = (cx - HALF_W) * CELL;
  return i === 1 || i === 2 ? x0 + CELL : x0;
}
function cornerZ(cy, i) {
  const z0 = (cy - HALF_H) * CELL;
  return i === 2 || i === 3 ? z0 + CELL : z0;
}

// ---------------------------------------------------------------------------
// Vertical faces: walls, cliffs, ceiling bulkheads
// ---------------------------------------------------------------------------

function emitWalls(level, sink) {
  const { grid, headroom, zone } = level;

  for (let cy = 0; cy < GRID_H; cy++) {
    for (let cx = 0; cx < GRID_W; cx++) {
      const c = idx(cx, cy);

      for (let dir = 1; dir <= 4; dir++) {
        const nx = cx + (dir === DIR_PX ? 1 : dir === DIR_NX ? -1 : 0);
        const ny = cy + (dir === DIR_PZ ? 1 : dir === DIR_NZ ? -1 : 0);
        if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H) continue;
        const n = idx(nx, ny);

        const eHere = EDGE_CORNERS[dir];
        const eThere = EDGE_CORNERS[dir === DIR_PX ? DIR_NX : dir === DIR_NX ? DIR_PX
          : dir === DIR_PZ ? DIR_NZ : DIR_PZ];

        // --- A. Solid cell facing an open one: full-height wall, floor to ceiling.
        if (grid[c] === 1) {
          if (grid[n] !== 0) continue;
          readCorners(level, n, _cornerB);
          // The neighbour's edge corners, listed in this face's winding order.
          const h1 = _cornerB[eThere[1]];
          const h2 = _cornerB[eThere[0]];
          const y1 = h1 * RISE;
          const y2 = h2 * RISE;
          const room = headroom[n];
          pushVerticalQuad(sink, cx, cy, dir, eHere, y1, y2, y1 + room, y2 + room, ZONE_TINT[zone[n]], true);
          continue;
        }
        if (grid[n] !== 0) continue;

        readCorners(level, c, _cornerA);
        readCorners(level, n, _cornerB);

        // --- B. Two open cells at different elevations: a drop-off cliff.
        // Emitted once, by the lower side, facing back into it.
        const a1 = _cornerA[eHere[0]];
        const a2 = _cornerA[eHere[1]];
        const b1 = _cornerB[eThere[1]];
        const b2 = _cornerB[eThere[0]];
        if (b1 > a1 || b2 > a2) {
          pushVerticalQuad(
            sink, cx, cy, dir, eHere,
            a1 * RISE, a2 * RISE,
            Math.max(a1, b1) * RISE, Math.max(a2, b2) * RISE,
            ZONE_TINT[zone[c]], false,
          );
        }

        // --- C. Ceiling bulkhead where the neighbour's headroom is taller.
        // Visible from the taller side, so its normal points that way.
        const ceilHere = Math.max(a1, a2) * RISE + headroom[c];
        const ceilThere = Math.max(b1, b2) * RISE + headroom[n];
        if (ceilThere > ceilHere + 1e-4) {
          pushBulkhead(sink, cx, cy, dir, eHere, ceilHere, ceilThere, ZONE_TINT[zone[n]]);
        }
      }
    }
  }
}

/**
 * A vertical quad on the `dir` face of cell (cx, cy).
 *
 * `outward` picks the normal: a wall face is seen from the neighbour (normal
 * points out of this cell), a cliff face is seen from this cell (normal points
 * back in). Both share the corner geometry, only the winding flips.
 */
function pushVerticalQuad(sink, cx, cy, dir, edge, yLo1, yLo2, yHi1, yHi2, tint, outward) {
  if (yHi1 <= yLo1 + 1e-5 && yHi2 <= yLo2 + 1e-5) return;
  if (sink.counting) { sink.push(); return; }

  const i1 = edge[0];
  const i2 = edge[1];
  const x1 = cornerX(cx, i1);
  const z1 = cornerZ(cy, i1);
  const x2 = cornerX(cx, i2);
  const z2 = cornerZ(cy, i2);

  // Tile U along whichever horizontal axis this face runs.
  const alongX = dir === DIR_PZ || dir === DIR_NZ;
  const u1 = (alongX ? x1 : z1) / TEX_SCALE;
  const u2 = (alongX ? x2 : z2) / TEX_SCALE;

  const base = Math.min(yLo1, yLo2);
  const top = Math.max(yHi1, yHi2);
  const span = top - base > 1e-5 ? top - base : 1;

  const s = (y) => {
    const t = (y - base) / span;
    return tint * (AO_FLOOR + (AO_TOP - AO_FLOOR) * (t * t * 0.55 + t * 0.45));
  };

  if (outward) {
    setCorner(0, x1, yLo1, z1, u1, (yLo1 - base) / TEX_SCALE, s(yLo1));
    setCorner(1, x2, yLo2, z2, u2, (yLo2 - base) / TEX_SCALE, s(yLo2));
    setCorner(2, x2, yHi2, z2, u2, (yHi2 - base) / TEX_SCALE, s(yHi2));
    setCorner(3, x1, yHi1, z1, u1, (yHi1 - base) / TEX_SCALE, s(yHi1));
    sink.push(NORM_X[dir], 0, NORM_Z[dir]);
  } else {
    setCorner(0, x2, yLo2, z2, u2, (yLo2 - base) / TEX_SCALE, s(yLo2));
    setCorner(1, x1, yLo1, z1, u1, (yLo1 - base) / TEX_SCALE, s(yLo1));
    setCorner(2, x1, yHi1, z1, u1, (yHi1 - base) / TEX_SCALE, s(yHi1));
    setCorner(3, x2, yHi2, z2, u2, (yHi2 - base) / TEX_SCALE, s(yHi2));
    sink.push(-NORM_X[dir], 0, -NORM_Z[dir]);
  }
}

/** The soffit step where a low-ceilinged cell abuts a taller one. */
function pushBulkhead(sink, cx, cy, dir, edge, yLo, yHi, tint) {
  if (sink.counting) { sink.push(); return; }

  const i1 = edge[0];
  const i2 = edge[1];
  const x1 = cornerX(cx, i1);
  const z1 = cornerZ(cy, i1);
  const x2 = cornerX(cx, i2);
  const z2 = cornerZ(cy, i2);

  const alongX = dir === DIR_PZ || dir === DIR_NZ;
  const u1 = (alongX ? x1 : z1) / TEX_SCALE;
  const u2 = (alongX ? x2 : z2) / TEX_SCALE;
  const shade = tint * 0.5;

  setCorner(0, x1, yLo, z1, u1, 0, shade);
  setCorner(1, x2, yLo, z2, u2, 0, shade);
  setCorner(2, x2, yHi, z2, u2, (yHi - yLo) / TEX_SCALE, shade);
  setCorner(3, x1, yHi, z1, u1, (yHi - yLo) / TEX_SCALE, shade);
  sink.push(NORM_X[dir], 0, NORM_Z[dir]);
}

// ---------------------------------------------------------------------------
// Horizontal surfaces
// ---------------------------------------------------------------------------

/** Carpeted flat floor: the office and mezzanine strata. */
function emitCarpet(level, sink) {
  const { grid, conn, zone } = level;
  for (let cy = 0; cy < GRID_H; cy++) {
    for (let cx = 0; cx < GRID_W; cx++) {
      const c = idx(cx, cy);
      if (grid[c] !== 0 || conn[c] !== CONN_FLAT || zone[c] === Z_LOWER) continue;
      if (sink.counting) { sink.push(); continue; }
      pushFloorQuad(level, sink, cx, cy, c, TEX_SCALE, 1.0);
    }
  }
}

/** Concrete: connector surfaces plus the whole maintenance stratum. */
function emitHard(level, sink) {
  const { grid, conn, zone } = level;
  for (let cy = 0; cy < GRID_H; cy++) {
    for (let cx = 0; cx < GRID_W; cx++) {
      const c = idx(cx, cy);
      if (grid[c] !== 0) continue;

      if (conn[c] === CONN_STAIR) { emitFlight(level, sink, cx, cy, c); continue; }
      if (conn[c] !== CONN_FLAT) { // ramp: one tilted slab
        if (sink.counting) { sink.push(); continue; }
        pushFloorQuad(level, sink, cx, cy, c, TEX_SCALE_HARD, 0.86);
        continue;
      }
      if (zone[c] !== Z_LOWER) continue;
      if (sink.counting) { sink.push(); continue; }
      pushFloorQuad(level, sink, cx, cy, c, TEX_SCALE_HARD, 0.78);
    }
  }
}

function pushFloorQuad(level, sink, cx, cy, c, texScale, shade) {
  const h = cornerHu(level, c);
  const x0 = (cx - HALF_W) * CELL;
  const x1 = x0 + CELL;
  const z0 = (cy - HALF_H) * CELL;
  const z1 = z0 + CELL;

  // A, D, C, B — the winding that faces +Y.
  setCorner(0, x0, h[0] * RISE, z0, x0 / texScale, z0 / texScale, shade);
  setCorner(1, x0, h[3] * RISE, z1, x0 / texScale, z1 / texScale, shade);
  setCorner(2, x1, h[2] * RISE, z1, x1 / texScale, z1 / texScale, shade);
  setCorner(3, x1, h[1] * RISE, z0, x1 / texScale, z0 / texScale, shade);
  sink.push(0, 1, 0);
}

/**
 * One stair cell, drawn as STAIR_TREADS discrete treads and risers.
 *
 * Collision samples the same cell as a smooth incline (see floorYAt) — the
 * treads are a visual only. Stepping the collision to match would buy nothing
 * but a camera that stutters up every riser.
 */
function emitFlight(level, sink, cx, cy, c) {
  if (sink.counting) {
    for (let k = 0; k < STAIR_TREADS; k++) { sink.push(); sink.push(); } // riser + tread
    return;
  }

  const dir = level.slopeDir[c];
  const base = level.heights[c];
  const rise = level.slopeRise[c];
  const x0 = (cx - HALF_W) * CELL;
  const z0 = (cy - HALF_H) * CELL;

  const stepY = (rise * RISE) / STAIR_TREADS;
  const stepU = CELL / STAIR_TREADS;
  const yBase = base * RISE;

  // Axis the flight climbs along, and the sign of that climb.
  const alongX = dir === DIR_PX || dir === DIR_NX;
  const sign = dir === DIR_PX || dir === DIR_PZ ? 1 : -1;
  // Distance along the climb axis, measured from the downhill edge.
  const originU = alongX
    ? (sign > 0 ? x0 : x0 + CELL)
    : (sign > 0 ? z0 : z0 + CELL);
  // The full width of the flight, on the perpendicular axis.
  const w0 = alongX ? z0 : x0;
  const w1 = w0 + CELL;

  for (let k = 0; k < STAIR_TREADS; k++) {
    const uA = originU + sign * k * stepU;
    const uB = originU + sign * (k + 1) * stepU;
    const yTread = yBase + (k + 1) * stepY;
    const yPrev = yBase + k * stepY;

    // Riser: vertical, facing back down the flight.
    pushStairRiser(sink, alongX, uA, w0, w1, yPrev, yTread, -sign);
    // Tread: horizontal, at the top of that riser.
    pushStairTread(sink, alongX, uA, uB, w0, w1, yTread, sign);
  }
}

function pushStairTread(sink, alongX, uA, uB, w0, w1, y, sign) {
  const s = 0.92;
  if (alongX) {
    // Wind so the quad always faces +Y regardless of climb direction.
    if (sign > 0) {
      setCorner(0, uA, y, w0, uA / TEX_SCALE_HARD, w0 / TEX_SCALE_HARD, s);
      setCorner(1, uA, y, w1, uA / TEX_SCALE_HARD, w1 / TEX_SCALE_HARD, s);
      setCorner(2, uB, y, w1, uB / TEX_SCALE_HARD, w1 / TEX_SCALE_HARD, s);
      setCorner(3, uB, y, w0, uB / TEX_SCALE_HARD, w0 / TEX_SCALE_HARD, s);
    } else {
      setCorner(0, uB, y, w0, uB / TEX_SCALE_HARD, w0 / TEX_SCALE_HARD, s);
      setCorner(1, uB, y, w1, uB / TEX_SCALE_HARD, w1 / TEX_SCALE_HARD, s);
      setCorner(2, uA, y, w1, uA / TEX_SCALE_HARD, w1 / TEX_SCALE_HARD, s);
      setCorner(3, uA, y, w0, uA / TEX_SCALE_HARD, w0 / TEX_SCALE_HARD, s);
    }
  } else if (sign > 0) {
    setCorner(0, w0, y, uA, w0 / TEX_SCALE_HARD, uA / TEX_SCALE_HARD, s);
    setCorner(1, w0, y, uB, w0 / TEX_SCALE_HARD, uB / TEX_SCALE_HARD, s);
    setCorner(2, w1, y, uB, w1 / TEX_SCALE_HARD, uB / TEX_SCALE_HARD, s);
    setCorner(3, w1, y, uA, w1 / TEX_SCALE_HARD, uA / TEX_SCALE_HARD, s);
  } else {
    setCorner(0, w0, y, uB, w0 / TEX_SCALE_HARD, uB / TEX_SCALE_HARD, s);
    setCorner(1, w0, y, uA, w0 / TEX_SCALE_HARD, uA / TEX_SCALE_HARD, s);
    setCorner(2, w1, y, uA, w1 / TEX_SCALE_HARD, uA / TEX_SCALE_HARD, s);
    setCorner(3, w1, y, uB, w1 / TEX_SCALE_HARD, uB / TEX_SCALE_HARD, s);
  }
  sink.push(0, 1, 0);
}

function pushStairRiser(sink, alongX, u, w0, w1, yLo, yHi, facing) {
  const s = 0.6;
  if (alongX) {
    if (facing > 0) {
      setCorner(0, u, yLo, w1, w1 / TEX_SCALE_HARD, yLo / TEX_SCALE_HARD, s);
      setCorner(1, u, yLo, w0, w0 / TEX_SCALE_HARD, yLo / TEX_SCALE_HARD, s);
      setCorner(2, u, yHi, w0, w0 / TEX_SCALE_HARD, yHi / TEX_SCALE_HARD, s);
      setCorner(3, u, yHi, w1, w1 / TEX_SCALE_HARD, yHi / TEX_SCALE_HARD, s);
    } else {
      setCorner(0, u, yLo, w0, w0 / TEX_SCALE_HARD, yLo / TEX_SCALE_HARD, s);
      setCorner(1, u, yLo, w1, w1 / TEX_SCALE_HARD, yLo / TEX_SCALE_HARD, s);
      setCorner(2, u, yHi, w1, w1 / TEX_SCALE_HARD, yHi / TEX_SCALE_HARD, s);
      setCorner(3, u, yHi, w0, w0 / TEX_SCALE_HARD, yHi / TEX_SCALE_HARD, s);
    }
    sink.push(facing, 0, 0);
  } else {
    if (facing > 0) {
      setCorner(0, w0, yLo, u, w0 / TEX_SCALE_HARD, yLo / TEX_SCALE_HARD, s);
      setCorner(1, w1, yLo, u, w1 / TEX_SCALE_HARD, yLo / TEX_SCALE_HARD, s);
      setCorner(2, w1, yHi, u, w1 / TEX_SCALE_HARD, yHi / TEX_SCALE_HARD, s);
      setCorner(3, w0, yHi, u, w0 / TEX_SCALE_HARD, yHi / TEX_SCALE_HARD, s);
    } else {
      setCorner(0, w1, yLo, u, w1 / TEX_SCALE_HARD, yLo / TEX_SCALE_HARD, s);
      setCorner(1, w0, yLo, u, w0 / TEX_SCALE_HARD, yLo / TEX_SCALE_HARD, s);
      setCorner(2, w0, yHi, u, w0 / TEX_SCALE_HARD, yHi / TEX_SCALE_HARD, s);
      setCorner(3, w1, yHi, u, w1 / TEX_SCALE_HARD, yHi / TEX_SCALE_HARD, s);
    }
    sink.push(0, 0, facing);
  }
}

/** Per-cell ceiling, following each stratum's headroom and raked over flights. */
function emitCeiling(level, sink) {
  const { grid, headroom } = level;
  for (let cy = 0; cy < GRID_H; cy++) {
    for (let cx = 0; cx < GRID_W; cx++) {
      const c = idx(cx, cy);
      if (grid[c] !== 0) continue;
      if (sink.counting) { sink.push(); continue; }

      const h = cornerHu(level, c);
      const room = headroom[c];
      const x0 = (cx - HALF_W) * CELL;
      const x1 = x0 + CELL;
      const z0 = (cy - HALF_H) * CELL;
      const z1 = z0 + CELL;

      // A, C, D, B — the +Y winding reversed, so the face looks down.
      setCorner(0, x0, h[0] * RISE + room, z0, x0 / TEX_SCALE, z0 / TEX_SCALE, 1);
      setCorner(1, x1, h[1] * RISE + room, z0, x1 / TEX_SCALE, z0 / TEX_SCALE, 1);
      setCorner(2, x1, h[2] * RISE + room, z1, x1 / TEX_SCALE, z1 / TEX_SCALE, 1);
      setCorner(3, x0, h[3] * RISE + room, z1, x0 / TEX_SCALE, z1 / TEX_SCALE, 1);
      sink.push(0, -1, 0);
    }
  }
}

// ---------------------------------------------------------------------------
// Public builders. Each runs its emitter twice: once to count, once to fill.
// ---------------------------------------------------------------------------

function build(level, emit, withColor) {
  const counter = countingSink();
  emit(level, counter);
  const sink = bufferSink(counter.count, withColor);
  emit(level, sink);
  return sink.build();
}

export function buildWallGeometry(level) { return build(level, emitWalls, true); }
export function buildFloorGeometry(level) { return build(level, emitCarpet, true); }
export function buildHardGeometry(level) { return build(level, emitHard, true); }
export function buildCeilingGeometry(level) { return build(level, emitCeiling, false); }
