import * as THREE from 'three';
import {
  GRID_W, GRID_H, CELL, HALF_W, HALF_H, TEX_SCALE, TEX_SCALE_HARD,
  RISE, STAIR_TREADS, Z_LOWER,
  CURVE_FILLET_R, CURVE_FILLET_SEGS, CURVE_ROOM_SEGS_PER_R,
} from './config.js';
import {
  idx, CONN_FLAT, CONN_STAIR, DIR_PX, DIR_NX, DIR_PZ, DIR_NZ, cornerHu as floorCornerHu,
} from './maze.js';
import { ceilCornerY } from './ceiling.js';
import { floorYAt, ceilYAt } from './collision.js';

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
/**
 * Contact darkening reaches this far up a wall and no further.
 *
 * Anchoring it to an absolute height rather than to the wall's own height is
 * what lets a 12m atrium wall exist: normalising over the full span would
 * gradient a cavernous room's floor into darkness and leave its ceiling lit,
 * which is exactly backwards.
 */
const AO_SPAN = 2.6;
/** Above this, surfaces fade out — the top of a shaft is simply not lit. */
const DARK_START = 4.0;
const DARK_RANGE = 12.0;
const DARK_FLOOR = 0.06;

/** Per-stratum surface tint, multiplied into the baked AO gradient. */
const ZONE_TINT = [0.72, 1.0, 0.92];

/**
 * Vertex brightness for a point `h` above the floor beneath it.
 *
 * Two regimes in one curve: contact shading over the first AO_SPAN, then a
 * long fade to near-black. That fade is what sells a maintenance shaft as
 * climbing into nothing without a single extra light, mesh or shader — the
 * geometry keeps going and simply stops being visible.
 */
function heightShade(h) {
  const t = h < AO_SPAN ? h / AO_SPAN : 1;
  let s = AO_FLOOR + (AO_TOP - AO_FLOOR) * (t * t * 0.55 + t * 0.45);
  if (h > DARK_START) {
    const f = 1 - (h - DARK_START) / DARK_RANGE;
    s *= f < DARK_FLOOR ? DARK_FLOOR : f;
  }
  return s;
}

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
  for (let i = 0; i < 4; i++) {
    _corner[i] = floorCornerHu(level.heights, level.slopeDir, level.slopeRise, c, i);
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
  const { grid, zone } = level;
  const circles = level.circleRooms || [];

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

        // --- A. Solid cell facing an open one: full-height wall, floor to the
        // neighbour's own ceiling — which now varies per corner, so this is a
        // general quad and a cavernous room simply produces a taller one.
        if (grid[c] === 1) {
          if (grid[n] !== 0) continue;
          // Circular chambers draw their own arc shell; skip the faceted face
          // so the curve is not doubled by a flat wall sitting on the same edge.
          if (faceReplacedByCircle(circles, cx, cy, nx, ny)) continue;
          // The neighbour's edge corners, listed in this face's winding order.
          const i1 = eThere[1];
          const i2 = eThere[0];
          const y1 = floorCornerHu(level.heights, level.slopeDir, level.slopeRise, n, i1) * RISE;
          const y2 = floorCornerHu(level.heights, level.slopeDir, level.slopeRise, n, i2) * RISE;
          // Fillets bite R off each end of a face that meets a convex corner.
          const inset = faceFilletInsets(level, cx, cy, dir);
          pushVerticalQuad(
            sink, cx, cy, dir, eHere, y1, y2,
            ceilCornerY(level, n, i1), ceilCornerY(level, n, i2),
            ZONE_TINT[zone[n]], true,
            inset.i0, inset.i1,
          );
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

        // --- C. Ceiling bulkhead where the neighbour's soffit is higher.
        //
        // This one comparison is the whole transition system. Two cells in a
        // lofted sector read the same lattice entry for the corners they share,
        // so ca === cb, nothing is emitted, and the ceiling slopes across the
        // join as one continuous surface for free. A cell that quantised its
        // ceiling disagrees, and the disagreement becomes the hard step.
        const ca1 = ceilCornerY(level, c, eHere[0]);
        const ca2 = ceilCornerY(level, c, eHere[1]);
        const cb1 = ceilCornerY(level, n, eThere[1]);
        const cb2 = ceilCornerY(level, n, eThere[0]);
        if (cb1 > ca1 + 1e-4 || cb2 > ca2 + 1e-4) {
          const floorRef = Math.min(a1, a2) * RISE;
          pushBulkhead(
            sink, cx, cy, dir, eHere,
            ca1, ca2, Math.max(ca1, cb1), Math.max(ca2, cb2),
            ZONE_TINT[zone[n]], floorRef,
          );
        }
      }
    }
  }

  // Curved shells: circular chamber walls, then convex corner fillets.
  emitCircleWalls(level, sink);
  emitCornerFillets(level, sink);
}

/**
 * True when the open cell sits inside a circular chamber and the solid sits
 * outside (or on the ring) — the arc wall owns that transition.
 */
function faceReplacedByCircle(circles, solidCx, solidCy, openCx, openCy) {
  if (!circles.length) return false;
  const ox = (openCx - HALF_W + 0.5) * CELL;
  const oz = (openCy - HALF_H + 0.5) * CELL;
  const sx = (solidCx - HALF_W + 0.5) * CELL;
  const sz = (solidCy - HALF_H + 0.5) * CELL;
  for (let i = 0; i < circles.length; i++) {
    const room = circles[i];
    const dox = ox - room.wx;
    const doz = oz - room.wz;
    const dsx = sx - room.wx;
    const dsz = sz - room.wz;
    const openD2 = dox * dox + doz * doz;
    const solidD2 = dsx * dsx + dsz * dsz;
    const rIn = room.radius - CELL * 0.15;
    const rOut = room.radius + CELL * 0.55;
    if (openD2 < rIn * rIn && solidD2 > (room.radius - CELL * 0.55) * (room.radius - CELL * 0.55)
      && solidD2 < rOut * rOut) {
      return true;
    }
  }
  return false;
}

/** Deterministic per-corner fillet keep bit (no RNG stream). */
function filletKeep(cx, cy, corner, chance) {
  let h = (cx * 73856093) ^ (cy * 19349663) ^ (corner * 83492791) ^ 0x2f4a9c;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return ((h >>> 0) / 4294967296) < chance;
}

/**
 * Convex solid corners that get a fillet.
 *
 * Arc lives in the SOLID quadrant so its ends land on the two wall faces:
 *   corner 0 (+X+Z open): ends at (px, pz-R) and (px-R, pz) — east & north faces
 * Those faces are shortened by R so the arc meets them with no gap.
 *
 * a0..a1 are the solid-quadrant angles (centre at the cell corner).
 */
const FILLET_CORNERS = [
  // open +X+Z → solid arc west→south
  { dx: 1, dz: 1, openA: DIR_PX, openB: DIR_PZ, a0: Math.PI, a1: Math.PI * 1.5 },
  // open -X+Z → solid arc south→east
  { dx: 0, dz: 1, openA: DIR_NX, openB: DIR_PZ, a0: Math.PI * 1.5, a1: Math.PI * 2 },
  // open -X-Z → solid arc east→north
  { dx: 0, dz: 0, openA: DIR_NX, openB: DIR_NZ, a0: 0, a1: Math.PI * 0.5 },
  // open +X-Z → solid arc north→west
  { dx: 1, dz: 0, openA: DIR_PX, openB: DIR_NZ, a0: Math.PI * 0.5, a1: Math.PI },
];

/** Is this solid-cell corner a live convex fillet? */
function isFilletCorner(level, cx, cy, corner) {
  const grid = level.grid;
  if (cx < 1 || cy < 1 || cx >= GRID_W - 1 || cy >= GRID_H - 1) return false;
  const c = idx(cx, cy);
  if (grid[c] !== 1) return false;
  const def = FILLET_CORNERS[corner];
  const nA = c + DIR_OFF_LOCAL[def.openA];
  const nB = c + DIR_OFF_LOCAL[def.openB];
  if (grid[nA] !== 0 || grid[nB] !== 0) return false;
  const nD = nA + (nB - c);
  if (nD < 0 || nD >= grid.length || grid[nD] !== 0) return false;
  return filletKeep(cx, cy, corner, level.filletChance ?? 0.5);
}

const DIR_OFF_LOCAL = [0, 1, -1, GRID_W, -GRID_W];

/**
 * How much to bite off each end of a solid wall face for live fillets.
 * EDGE_CORNERS[dir] first/second map to FILLET_CORNERS indices below.
 */
function faceFilletInsets(level, cx, cy, dir) {
  // A=(x0,z0), B=(x1,z0), C=(x1,z1), D=(x0,z1)
  // DIR_PX edge [2,1]=C,B → fillets 0 (+X+Z), 3 (+X-Z)
  // DIR_NX edge [0,3]=A,D → fillets 2 (-X-Z), 1 (-X+Z)
  // DIR_PZ edge [3,2]=D,C → fillets 1 (-X+Z), 0 (+X+Z)
  // DIR_NZ edge [1,0]=B,A → fillets 3 (+X-Z), 2 (-X-Z)
  let c0;
  let c1;
  if (dir === DIR_PX) { c0 = 0; c1 = 3; }
  else if (dir === DIR_NX) { c0 = 2; c1 = 1; }
  else if (dir === DIR_PZ) { c0 = 1; c1 = 0; }
  else { c0 = 3; c1 = 2; }

  const R = CURVE_FILLET_R;
  return {
    i0: isFilletCorner(level, cx, cy, c0) ? R : 0,
    i1: isFilletCorner(level, cx, cy, c1) ? R : 0,
  };
}

/**
 * Vertical arc strip: posts at (x0,z0)/(x1,z1), floor→ceil at each.
 * Winding is chosen so the front face points along (nx, nz) — required for
 * FrontSide wall materials, otherwise the strip is culled and you see through.
 */
function pushArcStrip(sink, x0, z0, x1, z1, yLo0, yHi0, yLo1, yHi1, tint, nx, nz) {
  if (yHi0 <= yLo0 + 1e-5 && yHi1 <= yLo1 + 1e-5) return;
  if (sink.counting) { sink.push(); return; }

  const base = Math.min(yLo0, yLo1);
  const s = (y) => tint * heightShade(y - base);
  const du = Math.hypot(x1 - x0, z1 - z0) / TEX_SCALE;

  // Three.js FrontSide culls by triangle winding. bottom×up = (-(z1-z0), 0,
  // x1-x0); reverse the bottom edge when that disagrees with (nx, nz) so the
  // geometric normal faces the player.
  const align = -(z1 - z0) * nx + (x1 - x0) * nz;
  let ax0 = x0;
  let az0 = z0;
  let ax1 = x1;
  let az1 = z1;
  let yL0 = yLo0;
  let yH0 = yHi0;
  let yL1 = yLo1;
  let yH1 = yHi1;
  if (align < 0) {
    ax0 = x1; az0 = z1; ax1 = x0; az1 = z0;
    yL0 = yLo1; yH0 = yHi1; yL1 = yLo0; yH1 = yHi0;
  }

  setCorner(0, ax0, yL0, az0, 0, (yL0 - base) / TEX_SCALE, s(yL0));
  setCorner(1, ax1, yL1, az1, du, (yL1 - base) / TEX_SCALE, s(yL1));
  setCorner(2, ax1, yH1, az1, du, (yH1 - base) / TEX_SCALE, s(yH1));
  setCorner(3, ax0, yH0, az0, 0, (yH0 - base) / TEX_SCALE, s(yH0));
  sink.push(nx, 0, nz);
}

/**
 * True cylindrical chamber walls. Floor/ceiling sampled slightly inside the
 * chamber so solid-cell height buffers (often zero) never starve the strip.
 */
function emitCircleWalls(level, sink) {
  const rooms = level.circleRooms;
  if (!rooms || !rooms.length) return;
  const { zone, grid } = level;

  for (let r = 0; r < rooms.length; r++) {
    const room = rooms[r];
    const segs = Math.max(16, (room.rCells * CURVE_ROOM_SEGS_PER_R) | 0);
    const twoPi = Math.PI * 2;

    for (let s = 0; s < segs; s++) {
      const a0 = (s / segs) * twoPi;
      const a1 = ((s + 1) / segs) * twoPi;
      const am = (a0 + a1) * 0.5;

      const outX = room.wx + Math.cos(am) * (room.radius + CELL * 0.35);
      const outZ = room.wz + Math.sin(am) * (room.radius + CELL * 0.35);
      const inX = room.wx + Math.cos(am) * (room.radius - CELL * 0.45);
      const inZ = room.wz + Math.sin(am) * (room.radius - CELL * 0.45);

      const outCx = ((outX / CELL) + HALF_W) | 0;
      const outCy = ((outZ / CELL) + HALF_H) | 0;
      const inCx = ((inX / CELL) + HALF_W) | 0;
      const inCy = ((inZ / CELL) + HALF_H) | 0;
      if (outCx < 0 || outCy < 0 || outCx >= GRID_W || outCy >= GRID_H) continue;
      if (inCx < 0 || inCy < 0 || inCx >= GRID_W || inCy >= GRID_H) continue;
      // Corridor punched through the ring: leave a doorway (no arc, no flat wall).
      if (grid[idx(outCx, outCy)] === 0) continue;
      if (grid[idx(inCx, inCy)] !== 0) continue;

      const x0 = room.wx + Math.cos(a0) * room.radius;
      const z0 = room.wz + Math.sin(a0) * room.radius;
      const x1 = room.wx + Math.cos(a1) * room.radius;
      const z1 = room.wz + Math.sin(a1) * room.radius;

      // Interior samples for vertical extents.
      const ix0 = room.wx + Math.cos(a0) * (room.radius - CELL * 0.4);
      const iz0 = room.wz + Math.sin(a0) * (room.radius - CELL * 0.4);
      const ix1 = room.wx + Math.cos(a1) * (room.radius - CELL * 0.4);
      const iz1 = room.wz + Math.sin(a1) * (room.radius - CELL * 0.4);

      const yLo0 = floorYAt(level, ix0, iz0);
      const yLo1 = floorYAt(level, ix1, iz1);
      const yHi0 = ceilYAt(level, ix0, iz0);
      const yHi1 = ceilYAt(level, ix1, iz1);

      const nx = -Math.cos(am);
      const nz = -Math.sin(am);
      pushArcStrip(
        sink, x0, z0, x1, z1, yLo0, yHi0, yLo1, yHi1,
        ZONE_TINT[zone[idx(inCx, inCy)]], nx, nz,
      );
    }
  }
}

/**
 * Shared fillet walk. Callback receives world-space corner, solid-quadrant
 * angles, open-side floor/ceil heights, and the open neighbour's zone.
 */
function forEachFillet(level, fn) {
  const { zone } = level;
  for (let cy = 1; cy < GRID_H - 1; cy++) {
    for (let cx = 1; cx < GRID_W - 1; cx++) {
      if (level.grid[idx(cx, cy)] !== 1) continue;
      for (let k = 0; k < 4; k++) {
        if (!isFilletCorner(level, cx, cy, k)) continue;
        const def = FILLET_CORNERS[k];
        const x0 = (cx - HALF_W) * CELL;
        const z0 = (cy - HALF_H) * CELL;
        const px = x0 + def.dx * CELL;
        const pz = z0 + def.dz * CELL;

        const nA = idx(cx, cy) + DIR_OFF_LOCAL[def.openA];
        const openZone = zone[nA] || 1;

        const ox = (def.openA === DIR_PX || def.openB === DIR_PX ? 0.3 : 0)
          + (def.openA === DIR_NX || def.openB === DIR_NX ? -0.3 : 0);
        const oz = (def.openA === DIR_PZ || def.openB === DIR_PZ ? 0.3 : 0)
          + (def.openA === DIR_NZ || def.openB === DIR_NZ ? -0.3 : 0);
        const yLo = floorYAt(level, px + ox, pz + oz);
        const yHi = ceilYAt(level, px + ox, pz + oz);
        if (yHi <= yLo + 0.05) continue;

        fn({ px, pz, a0: def.a0, a1: def.a1, yLo, yHi, openZone });
      }
    }
  }
}

/**
 * Quarter-cylinder fillets on convex solid corners.
 *
 * The arc sits in the solid footprint and joins the two shortened wall faces
 * at their new endpoints — so there is no see-through gap. Collision stays
 * the full solid cell (conservative); the curve is visual only.
 */
function emitCornerFillets(level, sink) {
  const R = CURVE_FILLET_R;
  const segs = CURVE_FILLET_SEGS;

  forEachFillet(level, ({ px, pz, a0, a1, yLo, yHi, openZone }) => {
    const tint = ZONE_TINT[openZone];
    for (let s = 0; s < segs; s++) {
      const t0 = s / segs;
      const t1 = (s + 1) / segs;
      const ang0 = a0 + (a1 - a0) * t0;
      const ang1 = a0 + (a1 - a0) * t1;
      const am = (ang0 + ang1) * 0.5;

      const ax0 = px + Math.cos(ang0) * R;
      const az0 = pz + Math.sin(ang0) * R;
      const ax1 = px + Math.cos(ang1) * R;
      const az1 = pz + Math.sin(ang1) * R;

      // Out of the solid, toward the open corner (and the player).
      const nx = -Math.cos(am);
      const nz = -Math.sin(am);
      pushArcStrip(sink, ax0, az0, ax1, az1, yLo, yHi, yLo, yHi, tint, nx, nz);
    }
  });
}

/**
 * Floor/ceiling pie under a fillet arc.
 *
 * The rounded wall lives inside a solid cell, so the usual open-cell floor and
 * ceiling quads never cover the quarter-disk between the arc and the original
 * corner — that is the black gap at the top and bottom of every fillet.
 *
 * `which`: 'floor' (+Y, carpet/hard) or 'ceiling' (-Y).
 * `hardOnly`: when true, only emit for maintenance-zone neighbours (hard mesh);
 *             when false, only emit for office/mezzanine (carpet mesh).
 *             Ignored for ceilings.
 */
function emitFilletCaps(level, sink, which, hardOnly) {
  // Slightly past the wall arc so the cap tucks under the vertical strip and
  // no hairline opens at the join under glancing light.
  const R = CURVE_FILLET_R + 0.03;
  const segs = CURVE_FILLET_SEGS;
  const isCeil = which === 'ceiling';
  const tex = isCeil ? TEX_SCALE : (hardOnly ? TEX_SCALE_HARD : TEX_SCALE);
  const shadeFloor = hardOnly ? 0.78 : 1.0;

  forEachFillet(level, ({ px, pz, a0, a1, yLo, yHi, openZone }) => {
    if (!isCeil) {
      if (hardOnly && openZone !== Z_LOWER) return;
      if (!hardOnly && openZone === Z_LOWER) return;
    }
    const y = isCeil ? yHi : yLo;
    const shade = isCeil ? heightShade(yHi - yLo) : shadeFloor;

    for (let s = 0; s < segs; s++) {
      if (sink.counting) { sink.push(); continue; }
      const t0 = s / segs;
      const t1 = (s + 1) / segs;
      const ang0 = a0 + (a1 - a0) * t0;
      const ang1 = a0 + (a1 - a0) * t1;
      const x0 = px + Math.cos(ang0) * R;
      const z0 = pz + Math.sin(ang0) * R;
      const x1 = px + Math.cos(ang1) * R;
      const z1 = pz + Math.sin(ang1) * R;

      // Fan as a quad with a repeated centre (second tri degenerates).
      //
      // Solid-quadrant arcs run a0→a1 with increasing angle, but the solid
      // pie sits "inside" that sweep such that centre→p0→p1 has geometric
      // normal −Y (verified by cross product). Floor needs +Y so it uses the
      // reversed order; ceiling needs −Y so it keeps centre→p0→p1.
      // Getting this wrong backface-culls the whole pie → black gaps.
      if (isCeil) {
        setCorner(0, px, y, pz, px / tex, pz / tex, shade);
        setCorner(1, x0, y, z0, x0 / tex, z0 / tex, shade);
        setCorner(2, x1, y, z1, x1 / tex, z1 / tex, shade);
        setCorner(3, px, y, pz, px / tex, pz / tex, shade);
        sink.push(0, -1, 0);
      } else {
        setCorner(0, px, y, pz, px / tex, pz / tex, shade);
        setCorner(1, x1, y, z1, x1 / tex, z1 / tex, shade);
        setCorner(2, x0, y, z0, x0 / tex, z0 / tex, shade);
        setCorner(3, px, y, pz, px / tex, pz / tex, shade);
        sink.push(0, 1, 0);
      }
    }
  });
}

/**
 * A vertical quad on the `dir` face of cell (cx, cy).
 *
 * `outward` picks the normal: a wall face is seen from the neighbour (normal
 * points out of this cell), a cliff face is seen from this cell (normal points
 * back in). Both share the corner geometry, only the winding flips.
 */
function pushVerticalQuad(sink, cx, cy, dir, edge, yLo1, yLo2, yHi1, yHi2, tint, outward, inset0 = 0, inset1 = 0) {
  if (yHi1 <= yLo1 + 1e-5 && yHi2 <= yLo2 + 1e-5) return;
  // Both ends filleted away — nothing left of this face.
  if (inset0 + inset1 >= CELL - 1e-4) return;
  if (sink.counting) { sink.push(); return; }

  const i1 = edge[0];
  const i2 = edge[1];
  let x1 = cornerX(cx, i1);
  let z1 = cornerZ(cy, i1);
  let x2 = cornerX(cx, i2);
  let z2 = cornerZ(cy, i2);

  // Pull endpoints inward along the edge so a fillet arc can meet them.
  if (inset0 > 0 || inset1 > 0) {
    const len = Math.hypot(x2 - x1, z2 - z1) || 1;
    const ux = (x2 - x1) / len;
    const uz = (z2 - z1) / len;
    if (inset0 > 0) { x1 += ux * inset0; z1 += uz * inset0; }
    if (inset1 > 0) { x2 -= ux * inset1; z2 -= uz * inset1; }
    // Lerp heights to match the shortened posts.
    const t0 = inset0 / len;
    const t1 = inset1 / len;
    const yL1 = yLo1 + (yLo2 - yLo1) * t0;
    const yL2 = yLo2 + (yLo1 - yLo2) * t1;
    const yH1 = yHi1 + (yHi2 - yHi1) * t0;
    const yH2 = yHi2 + (yHi1 - yHi2) * t1;
    yLo1 = yL1; yLo2 = yL2; yHi1 = yH1; yHi2 = yH2;
  }

  // Tile U along whichever horizontal axis this face runs.
  const alongX = dir === DIR_PZ || dir === DIR_NZ;
  const u1 = (alongX ? x1 : z1) / TEX_SCALE;
  const u2 = (alongX ? x2 : z2) / TEX_SCALE;

  const base = Math.min(yLo1, yLo2);
  const s = (y) => tint * heightShade(y - base);

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

/**
 * The soffit step where a low-ceilinged cell abuts a taller one. Corners are
 * independent, so a step against a sloping ceiling comes out as the trapezoid
 * it actually is rather than a rectangle with a gap over it.
 */
function pushBulkhead(sink, cx, cy, dir, edge, yLo1, yLo2, yHi1, yHi2, tint, floorRef) {
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
  // Shaded against the floor below, not against the step itself, so a bulkhead
  // high in an atrium goes as dark as the wall it sits on.
  const s = (y) => tint * 0.62 * heightShade(y - floorRef);
  const vBase = Math.min(yLo1, yLo2);

  setCorner(0, x1, yLo1, z1, u1, (yLo1 - vBase) / TEX_SCALE, s(yLo1));
  setCorner(1, x2, yLo2, z2, u2, (yLo2 - vBase) / TEX_SCALE, s(yLo2));
  setCorner(2, x2, yHi2, z2, u2, (yHi2 - vBase) / TEX_SCALE, s(yHi2));
  setCorner(3, x1, yHi1, z1, u1, (yHi1 - vBase) / TEX_SCALE, s(yHi1));
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
  // Pie under rounded corners that sit inside solid cells (no open-cell floor).
  emitFilletCaps(level, sink, 'floor', false);
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
  emitFilletCaps(level, sink, 'floor', true);
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

/**
 * The ceiling, lofted across its four corner heights.
 *
 * A cell in a lofted sector shares those corner values with its neighbours, so
 * the surface is continuous — a sagging ceiling costs exactly as many triangles
 * as a flat one. A cell that quantised gets four equal corners and reads as a
 * flat panel, with the step to its neighbour handled by the bulkhead pass.
 *
 * Vertex shading falls off with height above the floor, so a shaft's soffit is
 * effectively invisible: the geometry recedes into black rather than being
 * capped by a lid the player can see.
 */
function emitCeiling(level, sink) {
  const { grid } = level;
  for (let cy = 0; cy < GRID_H; cy++) {
    for (let cx = 0; cx < GRID_W; cx++) {
      const c = idx(cx, cy);
      if (grid[c] !== 0) continue;
      if (sink.counting) { sink.push(); continue; }

      const h = cornerHu(level, c);
      const x0 = (cx - HALF_W) * CELL;
      const x1 = x0 + CELL;
      const z0 = (cy - HALF_H) * CELL;
      const z1 = z0 + CELL;

      const yA = ceilCornerY(level, c, 0);
      const yB = ceilCornerY(level, c, 1);
      const yC = ceilCornerY(level, c, 2);
      const yD = ceilCornerY(level, c, 3);

      // A, C, D, B — the +Y winding reversed, so the face looks down.
      setCorner(0, x0, yA, z0, x0 / TEX_SCALE, z0 / TEX_SCALE, heightShade(yA - h[0] * RISE));
      setCorner(1, x1, yB, z0, x1 / TEX_SCALE, z0 / TEX_SCALE, heightShade(yB - h[1] * RISE));
      setCorner(2, x1, yC, z1, x1 / TEX_SCALE, z1 / TEX_SCALE, heightShade(yC - h[2] * RISE));
      setCorner(3, x0, yD, z1, x0 / TEX_SCALE, z1 / TEX_SCALE, heightShade(yD - h[3] * RISE));
      sink.push(0, -1, 0);
    }
  }
  // Pie over rounded corners (solid cells never get a ceiling quad of their own).
  emitFilletCaps(level, sink, 'ceiling', false);
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
export function buildCeilingGeometry(level) { return build(level, emitCeiling, true); }
