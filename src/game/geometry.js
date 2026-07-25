import * as THREE from 'three';
import {
  GRID_W, GRID_H, CELL, CEILING_Y, HALF_W, HALF_H, TEX_SCALE, LEVEL_STEP,
} from './config.js';
import { idx } from './maze.js';

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
 * Result: walls are 1 draw call, floor is 1 draw call.
 *
 * Baked vertical gradient is written into a color attribute — cheap fake AO
 * that costs zero runtime and replaces any need for shadow-casting lights.
 *
 * Verticality: every open cell has a height tier (`heights`, in units of
 * LEVEL_STEP) from the maze's blob-carving pass. Two adjacent open cells at
 * different tiers always differ by exactly one step (guaranteed by BFS-layer
 * construction in maze.js), so the transition between them is either a short
 * riser (rendered here as a wall-like quad — "stairs") or, for cells flagged
 * in `rampCells`, a tilted floor quad ("ramp"). The ceiling stays one flat
 * plane regardless — see CEILING_Y in config.js.
 */

const AO_FLOOR = 0.34; // vertex brightness at the base of a wall
const AO_TOP = 1.0;

/** First lower open neighbour of a ramp-styled cell, in a fixed scan order. */
function rampNeighbor(grid, heights, rampCells, cx, cy) {
  const c = idx(cx, cy);
  if (!rampCells[c]) return null;
  const h = heights[c];
  if (cx + 1 < GRID_W) {
    const n = idx(cx + 1, cy);
    if (grid[n] === 0 && heights[n] < h) return { dir: 'px', n, h: heights[n] };
  }
  if (cx - 1 >= 0) {
    const n = idx(cx - 1, cy);
    if (grid[n] === 0 && heights[n] < h) return { dir: 'nx', n, h: heights[n] };
  }
  if (cy + 1 < GRID_H) {
    const n = idx(cx, cy + 1);
    if (grid[n] === 0 && heights[n] < h) return { dir: 'pz', n, h: heights[n] };
  }
  if (cy - 1 >= 0) {
    const n = idx(cx, cy - 1);
    if (grid[n] === 0 && heights[n] < h) return { dir: 'nz', n, h: heights[n] };
  }
  return null;
}

export function buildWallGeometry(grid, heights, rampCells) {
  // --- Pass 1: count exposed faces so the typed arrays are sized exactly once.
  let faceCount = 0;
  for (let cy = 0; cy < GRID_H; cy++) {
    for (let cx = 0; cx < GRID_W; cx++) {
      const c = idx(cx, cy);
      if (grid[c] === 1) {
        if (cx + 1 < GRID_W && grid[idx(cx + 1, cy)] === 0) faceCount++;
        if (cx - 1 >= 0 && grid[idx(cx - 1, cy)] === 0) faceCount++;
        if (cy + 1 < GRID_H && grid[idx(cx, cy + 1)] === 0) faceCount++;
        if (cy - 1 >= 0 && grid[idx(cx, cy - 1)] === 0) faceCount++;
      } else {
        const ramp = rampNeighbor(grid, heights, rampCells, cx, cy);
        const rampDir = ramp ? ramp.dir : null;
        if (cx + 1 < GRID_W && grid[idx(cx + 1, cy)] === 0 && heights[idx(cx + 1, cy)] !== heights[c] && rampDir !== 'px') faceCount++;
        if (cx - 1 >= 0 && grid[idx(cx - 1, cy)] === 0 && heights[idx(cx - 1, cy)] !== heights[c] && rampDir !== 'nx') faceCount++;
        if (cy + 1 < GRID_H && grid[idx(cx, cy + 1)] === 0 && heights[idx(cx, cy + 1)] !== heights[c] && rampDir !== 'pz') faceCount++;
        if (cy - 1 >= 0 && grid[idx(cx, cy - 1)] === 0 && heights[idx(cx, cy - 1)] !== heights[c] && rampDir !== 'nz') faceCount++;
      }
    }
  }

  const vertCount = faceCount * 6; // 2 triangles, non-indexed
  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const colors = new Float32Array(vertCount * 3);

  let p = 0;
  let n = 0;
  let u = 0;
  let c = 0;

  // Quad emitter. Corners must arrive CCW as seen from the face normal.
  // uAxis: 0 = tile U from world X, 1 = tile U from world Z.
  function quad(
    ax, ay, az, bx, by, bz, cx2, cy2, cz, dx, dy, dz,
    nx, ny, nz, uAxis, yBase, yTop,
  ) {
    // 2 triangles: A B C, A C D
    emit(ax, ay, az, nx, ny, nz, uAxis, yBase, yTop);
    emit(bx, by, bz, nx, ny, nz, uAxis, yBase, yTop);
    emit(cx2, cy2, cz, nx, ny, nz, uAxis, yBase, yTop);
    emit(ax, ay, az, nx, ny, nz, uAxis, yBase, yTop);
    emit(cx2, cy2, cz, nx, ny, nz, uAxis, yBase, yTop);
    emit(dx, dy, dz, nx, ny, nz, uAxis, yBase, yTop);
  }

  function emit(x, y, z, nx, ny, nz, uAxis, yBase, yTop) {
    positions[p++] = x; positions[p++] = y; positions[p++] = z;
    normals[n++] = nx; normals[n++] = ny; normals[n++] = nz;
    uvs[u++] = (uAxis === 0 ? x : z) / TEX_SCALE;
    uvs[u++] = (y - yBase) / TEX_SCALE;
    const t = (y - yBase) / (yTop - yBase);
    const shade = AO_FLOOR + (AO_TOP - AO_FLOOR) * (t * t * 0.55 + t * 0.45);
    colors[c++] = shade; colors[c++] = shade; colors[c++] = shade;
  }

  for (let cy = 0; cy < GRID_H; cy++) {
    const z0 = (cy - HALF_H) * CELL;
    const z1 = z0 + CELL;
    for (let cx = 0; cx < GRID_W; cx++) {
      const cellIdx = idx(cx, cy);
      const x0 = (cx - HALF_W) * CELL;
      const x1 = x0 + CELL;

      if (grid[cellIdx] === 1) {
        // Solid cell: emit a face wherever it borders an open cell, full height.
        if (cx + 1 < GRID_W && grid[idx(cx + 1, cy)] === 0) {
          const y0 = heights[idx(cx + 1, cy)] * LEVEL_STEP;
          quad(x1, y0, z1, x1, y0, z0, x1, CEILING_Y, z0, x1, CEILING_Y, z1, 1, 0, 0, 1, y0, CEILING_Y);
        }
        if (cx - 1 >= 0 && grid[idx(cx - 1, cy)] === 0) {
          const y0 = heights[idx(cx - 1, cy)] * LEVEL_STEP;
          quad(x0, y0, z0, x0, y0, z1, x0, CEILING_Y, z1, x0, CEILING_Y, z0, -1, 0, 0, 1, y0, CEILING_Y);
        }
        if (cy + 1 < GRID_H && grid[idx(cx, cy + 1)] === 0) {
          const y0 = heights[idx(cx, cy + 1)] * LEVEL_STEP;
          quad(x0, y0, z1, x1, y0, z1, x1, CEILING_Y, z1, x0, CEILING_Y, z1, 0, 0, 1, 0, y0, CEILING_Y);
        }
        if (cy - 1 >= 0 && grid[idx(cx, cy - 1)] === 0) {
          const y0 = heights[idx(cx, cy - 1)] * LEVEL_STEP;
          quad(x1, y0, z0, x0, y0, z0, x0, CEILING_Y, z0, x1, CEILING_Y, z0, 0, 0, -1, 0, y0, CEILING_Y);
        }
        continue;
      }

      // Open cell: emit a riser wherever a neighbour is open but at a
      // different tier, unless this is the one edge a ramp slopes down toward.
      const ownH = heights[cellIdx] * LEVEL_STEP;
      const ramp = rampNeighbor(grid, heights, rampCells, cx, cy);
      const rampDir = ramp ? ramp.dir : null;

      if (cx + 1 < GRID_W && rampDir !== 'px') {
        const ni = idx(cx + 1, cy);
        if (grid[ni] === 0 && heights[ni] !== heights[cellIdx]) {
          const nh = heights[ni] * LEVEL_STEP;
          const y0 = Math.min(ownH, nh);
          const y1 = Math.max(ownH, nh);
          quad(x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1, 1, 0, 0, 1, y0, y1);
        }
      }
      if (cx - 1 >= 0 && rampDir !== 'nx') {
        const ni = idx(cx - 1, cy);
        if (grid[ni] === 0 && heights[ni] !== heights[cellIdx]) {
          const nh = heights[ni] * LEVEL_STEP;
          const y0 = Math.min(ownH, nh);
          const y1 = Math.max(ownH, nh);
          quad(x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0, -1, 0, 0, 1, y0, y1);
        }
      }
      if (cy + 1 < GRID_H && rampDir !== 'pz') {
        const ni = idx(cx, cy + 1);
        if (grid[ni] === 0 && heights[ni] !== heights[cellIdx]) {
          const nh = heights[ni] * LEVEL_STEP;
          const y0 = Math.min(ownH, nh);
          const y1 = Math.max(ownH, nh);
          quad(x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, 0, 0, 1, 0, y0, y1);
        }
      }
      if (cy - 1 >= 0 && rampDir !== 'nz') {
        const ni = idx(cx, cy - 1);
        if (grid[ni] === 0 && heights[ni] !== heights[cellIdx]) {
          const nh = heights[ni] * LEVEL_STEP;
          const y0 = Math.min(ownH, nh);
          const y1 = Math.max(ownH, nh);
          quad(x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0, 0, 0, -1, 0, y0, y1);
        }
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Per-cell floor. Flat at the cell's own tier, except a ramp-flagged cell's
 * slope edge, which tilts two of its four corners down to the lower
 * neighbour's height — a cheap wedge that reads as an incline.
 */
export function buildFloorGeometry(grid, heights, rampCells) {
  let faceCount = 0;
  for (let i = 0; i < grid.length; i++) if (grid[i] === 0) faceCount++;

  const vertCount = faceCount * 6;
  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);

  let p = 0;
  let n = 0;
  let u = 0;

  function emit(x, y, z) {
    positions[p++] = x; positions[p++] = y; positions[p++] = z;
    normals[n++] = 0; normals[n++] = 1; normals[n++] = 0;
    uvs[u++] = x / TEX_SCALE;
    uvs[u++] = z / TEX_SCALE;
  }

  for (let cy = 0; cy < GRID_H; cy++) {
    const z0 = (cy - HALF_H) * CELL;
    const z1 = z0 + CELL;
    for (let cx = 0; cx < GRID_W; cx++) {
      const cellIdx = idx(cx, cy);
      if (grid[cellIdx] !== 0) continue;
      const x0 = (cx - HALF_W) * CELL;
      const x1 = x0 + CELL;
      const ownY = heights[cellIdx] * LEVEL_STEP;

      // Corners: A=(x0,z0) B=(x1,z0) C=(x1,z1) D=(x0,z1)
      let yA = ownY; let yB = ownY; let yC = ownY; let yD = ownY;
      const ramp = rampNeighbor(grid, heights, rampCells, cx, cy);
      if (ramp) {
        const ny = ramp.h * LEVEL_STEP;
        if (ramp.dir === 'px') { yB = ny; yC = ny; }
        else if (ramp.dir === 'nx') { yA = ny; yD = ny; }
        else if (ramp.dir === 'pz') { yC = ny; yD = ny; }
        else if (ramp.dir === 'nz') { yA = ny; yB = ny; }
      }

      // A,D,C then A,C,B — CCW as seen from +Y.
      emit(x0, yA, z0); emit(x0, yD, z1); emit(x1, yC, z1);
      emit(x0, yA, z0); emit(x1, yC, z1); emit(x1, yB, z0);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.computeBoundingSphere();
  return geo;
}

/** Ceiling is a single flat quad. UV tiling is handled by texture.repeat. */
export function buildSlabGeometry(y, faceUp) {
  const w = GRID_W * CELL;
  const h = GRID_H * CELL;
  const geo = new THREE.PlaneGeometry(w, h, 1, 1);
  geo.rotateX(faceUp ? -Math.PI / 2 : Math.PI / 2);
  geo.translate(0, y, 0);
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * (w / TEX_SCALE), uv.getY(i) * (h / TEX_SCALE));
  }
  uv.needsUpdate = true;
  geo.computeBoundingSphere();
  return geo;
}
