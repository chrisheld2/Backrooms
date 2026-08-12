import {
  GRID_W, GRID_H, CELL_COUNT, RISE,
  ZONE_HEADROOM, HEADROOM_SLOPE, RAMP_HEADROOM,
  CEIL_CHOKE, CEIL_SAG, CEIL_GALLERY, CEIL_VAULT, CEIL_ATRIUM, CEIL_SHAFT,
  CEIL_PLENUM_LIFT, CEIL_MIN, CEIL_WALK_MIN,
  CEILING_PROFILES,
} from './config.js';
import { DIR_OFF, CONN_FLAT, CONN_RAMP, cornerHu } from './grid.js';

/**
 * Ceiling architecture.
 *
 * The ceiling is stored as headroom at cell CORNERS, on a (GRID_W+1) x
 * (GRID_H+1) lattice, rather than one height per cell. Two adjacent cells read
 * the same lattice entry for the corners they share, which is what makes the
 * two transition styles fall out of one representation:
 *
 *   LOFT  the cell takes its four corners straight off the lattice. Its
 *         neighbours take the same values at the shared edge, so the surface
 *         is continuous across the whole sector and NO bulkhead geometry is
 *         emitted — a slow sag costs literally nothing to draw.
 *   CUT   the cell overrides all four corners with one quantised value. It
 *         disagrees with whatever abuts it, and the bulkhead emitter that
 *         already exists turns that disagreement into a hard vertical step.
 *
 * Ceiling height is relative to the floor beneath it, not absolute, so a
 * staircase carries its raked soffit up with it and a mezzanine does not have
 * its ceiling swallowed by the storey below.
 *
 * Spatial language (surreal, non-uniform):
 *   - Organic fBm baseline that breathes, floored so walking never forces crouch
 *   - Rare choke crawls (short corridor runs only)
 *   - Oppressive sags (standable but low)
 *   - Galleries / vaults / atriums / shafts for sudden vertical scale
 *
 * Runs once per level at generation time. Nothing here is called per frame.
 */

// Zone classification, per cell.
export const CEIL_STANDARD = 0;
export const CEIL_KIND_CHOKE = 1;
export const CEIL_KIND_ATRIUM = 2;
export const CEIL_KIND_SHAFT = 3;
export const CEIL_KIND_PLENUM = 4;
export const CEIL_KIND_GALLERY = 5;
export const CEIL_KIND_VAULT = 6;
export const CEIL_KIND_SAG = 7;

export const CEIL_MODE_LOFT = 0;
export const CEIL_MODE_CUT = 1;

const LAT_W = GRID_W + 1;
const LAT_COUNT = LAT_W * (GRID_H + 1);

// ---------------------------------------------------------------------------
// Seeded gradient (Perlin) noise + fBm. ~40 lines, no dependency, deterministic.
// ---------------------------------------------------------------------------

function makeNoise(seed) {
  // Seeded permutation table, doubled so the index wrap is a mask not a modulo.
  const p = new Uint8Array(512);
  const src = new Uint8Array(256);
  for (let i = 0; i < 256; i++) src[i] = i;
  let s = seed >>> 0;
  for (let i = 255; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    const t = src[i]; src[i] = src[j]; src[j] = t;
  }
  for (let i = 0; i < 512; i++) p[i] = src[i & 255];

  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  // 8 unit-ish gradients, selected by the low bits of the hash.
  const gx = [1, -1, 1, -1, 1, -1, 0, 0];
  const gy = [1, 1, -1, -1, 0, 0, 1, -1];

  return function noise2(x, y) {
    const xi = Math.floor(x) & 255;
    const yi = Math.floor(y) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const u = fade(xf);
    const v = fade(yf);

    const aa = p[p[xi] + yi] & 7;
    const ab = p[p[xi] + yi + 1] & 7;
    const ba = p[p[xi + 1] + yi] & 7;
    const bb = p[p[xi + 1] + yi + 1] & 7;

    const d00 = gx[aa] * xf + gy[aa] * yf;
    const d10 = gx[ba] * (xf - 1) + gy[ba] * yf;
    const d01 = gx[ab] * xf + gy[ab] * (yf - 1);
    const d11 = gx[bb] * (xf - 1) + gy[bb] * (yf - 1);

    const x1 = d00 + u * (d10 - d00);
    const x2 = d01 + u * (d11 - d01);
    return x1 + v * (x2 - x1); // roughly [-1, 1]
  };
}

function fbm(noise2, x, y, octaves) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let fx = x;
  let fy = y;
  for (let o = 0; o < octaves; o++) {
    sum += noise2(fx, fy) * amp;
    norm += amp;
    amp *= 0.5;
    fx *= 2.03; // irrational-ish lacunarity: octaves never re-align into banding
    fy *= 2.03;
  }
  return sum / norm;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/**
 * @param {object} lvl   a level with grid/heights/zone/conn/district already built
 * @param {number} levelId which CEILING_PROFILES entry to use
 * @param {Function} rng the level's seeded RNG
 */
export function buildCeiling(lvl, levelId, rng, seed) {
  const profile = CEILING_PROFILES[levelId] || CEILING_PROFILES[0];
  const { grid, zone, conn, district, openCells } = lvl;

  const headLat = new Float32Array(LAT_COUNT);
  const headFlat = new Float32Array(CELL_COUNT);
  const mode = new Uint8Array(CELL_COUNT);
  const kind = new Uint8Array(CELL_COUNT);
  /**
   * Does headFlat already hold a finished clear height, or an offset still
   * waiting to be added to the cell's stratum headroom?
   *
   * Tracked explicitly rather than inferred from `kind` in the resolve pass:
   * that inference is a list of exceptions that silently double-counts the
   * stratum the moment a new ceiling kind is added without updating it.
   */
  const absolute = new Uint8Array(CELL_COUNT);
  /** Lowest ceiling in the cell — what lamps hang from and clearance reads. */
  const ceilLowY = new Float32Array(CELL_COUNT);

  // --- 1. The organic baseline: fBm over the lattice.
  // Stored as an OFFSET, not an absolute height, because it is added to each
  // cell's own stratum headroom — the maintenance level stays lower and the
  // office floor stays tall while both breathe with the same field.
  // Bias is positive: more rooms lift than sag, so the building feels tall
  // with occasional compressions rather than uniformly low.
  const noise2 = makeNoise(seed ^ 0x51ed);
  let lo = Infinity;
  let hi = -Infinity;
  for (let ly = 0; ly <= GRID_H; ly++) {
    for (let lx = 0; lx <= GRID_W; lx++) {
      const n = fbm(noise2, lx * profile.noiseScale, ly * profile.noiseScale, profile.octaves);
      // Gentle second field at a different scale for long-wave "wrongness".
      const n2 = fbm(noise2, lx * profile.noiseScale * 0.37 + 19.1, ly * profile.noiseScale * 0.37 - 7.3, 2);
      const v = n * 0.72 + n2 * 0.28 + 0.18; // +0.18 bias → mostly above baseline
      headLat[ly * LAT_W + lx] = v;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  // Rescale the field to exactly ±jitter using its OWN extremes, then keep the
  // positive bias in the signed range so lifts are larger than dips.
  const span = Math.max(1e-6, Math.max(hi, -lo));
  const gain = profile.jitter / span;
  for (let i = 0; i < LAT_COUNT; i++) headLat[i] *= gain;

  // --- 2. Transition style per district. A district that CUTs quantises its
  // ceiling to a coarse step, so its rooms read as badly-built boxes rather
  // than a landscape.
  const cuts = new Uint8Array(Math.max(1, lvl.districtCount || 16));
  for (let d = 0; d < cuts.length; d++) cuts[d] = rng() < profile.steppedShare ? 1 : 0;

  const STEP = 0.34; // quantisation of a CUT sector, in world units
  for (let i = 0; i < openCells.length; i++) {
    const c = openCells[i];
    const d = district[c];
    if (d < 0 || !cuts[d]) { mode[c] = CEIL_MODE_LOFT; continue; }
    mode[c] = CEIL_MODE_CUT;
    // Average the four corners, then snap — neighbours in the same sector land
    // on the same step and stay flush; the sector edge steps hard.
    const cx = c % GRID_W;
    const cy = (c / GRID_W) | 0;
    const avg = 0.25 * (
      headLat[cy * LAT_W + cx] + headLat[cy * LAT_W + cx + 1]
      + headLat[(cy + 1) * LAT_W + cx] + headLat[(cy + 1) * LAT_W + cx + 1]
    );
    headFlat[c] = Math.round(avg / STEP) * STEP;
  }

  // --- 3. Degree map (corridor vs junction vs room).
  const degree = new Uint8Array(CELL_COUNT);
  for (let i = 0; i < openCells.length; i++) {
    const c = openCells[i];
    let n = 0;
    for (let dir = 1; dir <= 4; dir++) {
      const m = c + DIR_OFF[dir];
      if (m >= 0 && m < CELL_COUNT && grid[m] === 0) n++;
    }
    degree[c] = n;
  }

  // --- 4. Choke points — RARE. Short corridor crawls only.
  // A low ceiling over an open room reads as a mistake; over a hallway it is a
  // commitment. Keep them sparse so crouch stays a special event.
  const chokeLen = profile.chokeLen || [1, 3];
  for (let i = 0; i < openCells.length; i++) {
    const c = openCells[i];
    if (conn[c] !== CONN_FLAT || degree[c] > 2) continue;
    if (kind[c] !== CEIL_STANDARD) continue;
    if (rng() > profile.chokeChance) continue;
    let cur = c;
    const len = randRange(rng, chokeLen);
    for (let k = 0; k < len; k++) {
      if (grid[cur] !== 0 || conn[cur] !== CONN_FLAT || degree[cur] > 2) break;
      if (kind[cur] !== CEIL_STANDARD) break;
      mode[cur] = CEIL_MODE_CUT;
      kind[cur] = CEIL_KIND_CHOKE;
      headFlat[cur] = CEIL_CHOKE;
      absolute[cur] = 1;
      let next = -1;
      for (let dir = 1; dir <= 4; dir++) {
        const m = cur + DIR_OFF[dir];
        if (m < 0 || m >= CELL_COUNT || grid[m] !== 0) continue;
        if (kind[m] !== CEIL_STANDARD || degree[m] > 2) continue;
        next = m;
        break;
      }
      if (next < 0) break;
      cur = next;
    }
  }

  // --- 5. Oppressive sags: standable but low corridor compressions.
  // Same topology as chokes, different height — the building squeezes without
  // taking the posture choice away.
  const sagCount = randRange(rng, profile.sags || [0, 0]);
  const sagLen = profile.sagLen || [2, 4];
  for (let s = 0, guard = 0; s < sagCount && guard < 5000; guard++) {
    const c = openCells[(rng() * openCells.length) | 0];
    if (conn[c] !== CONN_FLAT || degree[c] > 2 || kind[c] !== CEIL_STANDARD) continue;
    let cur = c;
    const len = randRange(rng, sagLen);
    let claimed = 0;
    for (let k = 0; k < len; k++) {
      if (grid[cur] !== 0 || conn[cur] !== CONN_FLAT || degree[cur] > 2) break;
      if (kind[cur] !== CEIL_STANDARD) break;
      mode[cur] = CEIL_MODE_CUT;
      kind[cur] = CEIL_KIND_SAG;
      // Slight randomisation so consecutive sags don't tile as one panel.
      headFlat[cur] = CEIL_SAG + (rng() - 0.5) * 0.12;
      absolute[cur] = 1;
      claimed++;
      let next = -1;
      for (let dir = 1; dir <= 4; dir++) {
        const m = cur + DIR_OFF[dir];
        if (m < 0 || m >= CELL_COUNT || grid[m] !== 0) continue;
        if (kind[m] !== CEIL_STANDARD || degree[m] > 2) continue;
        next = m;
        break;
      }
      if (next < 0) break;
      cur = next;
    }
    if (claimed > 0) s++;
  }

  // --- 6. Galleries: double-height bays over open floor plan.
  const galleryCells = [];
  const galleryCount = randRange(rng, profile.galleries || [0, 0]);
  const galleryRadius = profile.galleryRadius || [2, 3];
  for (let g = 0, guard = 0; g < galleryCount && guard < 5000; guard++) {
    const core = openCells[(rng() * openCells.length) | 0];
    if (degree[core] < 3 || conn[core] !== CONN_FLAT || kind[core] !== CEIL_STANDARD) continue;
    const radius = randRange(rng, galleryRadius);
    const cx0 = core % GRID_W;
    const cy0 = (core / GRID_W) | 0;
    let claimed = 0;
    // Peak height wanders per gallery so no two tall rooms match.
    const peak = CEIL_GALLERY + (rng() - 0.35) * 1.8;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const cx = cx0 + dx;
        const cy = cy0 + dy;
        if (cx < 1 || cy < 1 || cx >= GRID_W - 1 || cy >= GRID_H - 1) continue;
        const c = cy * GRID_W + cx;
        if (grid[c] !== 0 || conn[c] !== CONN_FLAT) continue;
        if (kind[c] !== CEIL_STANDARD) continue;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > radius + 0.15) continue;
        const t = 1 - dist / (radius + 0.15);
        // Soft plateau: full height in the middle third, ramps at the rim.
        const ring = t > 0.55 ? 1 : t / 0.55;
        const base = ZONE_HEADROOM[zone[c]];
        mode[c] = CEIL_MODE_CUT;
        kind[c] = CEIL_KIND_GALLERY;
        headFlat[c] = base + (peak - base) * (0.55 + 0.45 * ring);
        absolute[c] = 1;
        galleryCells.push(c);
        claimed++;
      }
    }
    if (claimed > 0) g++;
  }

  // --- 7. Vaults: smooth dome lifted into the lattice (loft mode).
  // Continuous with neighbours so no bulkhead ring — the room opens upward.
  const vaultCells = [];
  const vaultCount = randRange(rng, profile.vaults || [0, 0]);
  const vaultRadius = profile.vaultRadius || [2, 3];
  for (let v = 0, guard = 0; v < vaultCount && guard < 5000; guard++) {
    const core = openCells[(rng() * openCells.length) | 0];
    if (degree[core] < 3 || conn[core] !== CONN_FLAT || kind[core] !== CEIL_STANDARD) continue;
    const radius = randRange(rng, vaultRadius);
    const cx0 = core % GRID_W;
    const cy0 = (core / GRID_W) | 0;
    const peak = CEIL_VAULT + rng() * 2.4;
    let claimed = 0;

    // Raise lattice corners under the dome (absolute clear-height deltas).
    for (let dy = -radius; dy <= radius + 1; dy++) {
      for (let dx = -radius; dx <= radius + 1; dx++) {
        const lx = cx0 + dx;
        const ly = cy0 + dy;
        if (lx < 0 || ly < 0 || lx > GRID_W || ly > GRID_H) continue;
        const dist = Math.sqrt((dx - 0.5) * (dx - 0.5) + (dy - 0.5) * (dy - 0.5));
        if (dist > radius + 0.6) continue;
        const t = 1 - dist / (radius + 0.6);
        const dome = t * t * (3 - 2 * t); // smoothstep
        const li = ly * LAT_W + lx;
        // Store as a lift on top of existing offset; resolve pass adds zone base.
        const lift = (peak - 3.2) * dome;
        if (lift > headLat[li]) headLat[li] = lift;
      }
    }

    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const cx = cx0 + dx;
        const cy = cy0 + dy;
        if (cx < 1 || cy < 1 || cx >= GRID_W - 1 || cy >= GRID_H - 1) continue;
        const c = cy * GRID_W + cx;
        if (grid[c] !== 0 || conn[c] !== CONN_FLAT) continue;
        if (kind[c] !== CEIL_STANDARD) continue;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > radius) continue;
        mode[c] = CEIL_MODE_LOFT;
        kind[c] = CEIL_KIND_VAULT;
        absolute[c] = 0;
        vaultCells.push(c);
        claimed++;
      }
    }
    if (claimed > 0) v++;
  }

  // --- 8. Atriums. Rare, open junctions: ring-stepped clerestory into black.
  const atriumCount = randRange(rng, profile.atriums);
  const atriumCells = [];
  for (let a = 0, guard = 0; a < atriumCount && guard < 4000; guard++) {
    const core = openCells[(rng() * openCells.length) | 0];
    if (degree[core] < 3 || conn[core] !== CONN_FLAT || kind[core] !== CEIL_STANDARD) continue;
    const radius = randRange(rng, profile.atriumRadius);

    const cx0 = core % GRID_W;
    const cy0 = (core / GRID_W) | 0;
    let claimed = 0;
    const peak = CEIL_ATRIUM + (rng() - 0.5) * 4.0;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const cx = cx0 + dx;
        const cy = cy0 + dy;
        if (cx < 1 || cy < 1 || cx >= GRID_W - 1 || cy >= GRID_H - 1) continue;
        const c = cy * GRID_W + cx;
        if (grid[c] !== 0 || conn[c] !== CONN_FLAT) continue;
        if (kind[c] === CEIL_KIND_CHOKE || kind[c] === CEIL_KIND_SAG) continue;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > radius) continue;
        const t = 1 - dist / radius;
        const ring = Math.ceil(t * 4) / 4; // 4 discrete steps down to the rim
        const base = ZONE_HEADROOM[zone[c]];
        mode[c] = CEIL_MODE_CUT;
        kind[c] = CEIL_KIND_ATRIUM;
        headFlat[c] = base + (peak - base) * ring;
        absolute[c] = 1;
        atriumCells.push(c);
        claimed++;
      }
    }
    if (claimed > 0) a++;
  }

  // --- 9. Shafts. A dead-end pocket with three walls, opened straight up.
  const shaftCount = randRange(rng, profile.shafts);
  const shaftCells = [];
  for (let s = 0, guard = 0; s < shaftCount && guard < 6000; guard++) {
    const c = openCells[(rng() * openCells.length) | 0];
    if (degree[c] > 1 || conn[c] !== CONN_FLAT || kind[c] !== CEIL_STANDARD) continue;
    mode[c] = CEIL_MODE_CUT;
    kind[c] = CEIL_KIND_SHAFT;
    headFlat[c] = CEIL_SHAFT;
    absolute[c] = 1;
    shaftCells.push(c);
    s++;
  }

  // --- 10. Missing ceiling tiles: the grid opens into the dark plenum above.
  const plenumCells = [];
  if (profile.plenumChance > 0) {
    for (let i = 0; i < openCells.length; i++) {
      const c = openCells[i];
      if (conn[c] !== CONN_FLAT || kind[c] !== CEIL_STANDARD) continue;
      if (rng() > profile.plenumChance) continue;
      mode[c] = CEIL_MODE_CUT;
      kind[c] = CEIL_KIND_PLENUM;
      headFlat[c] = ZONE_HEADROOM[zone[c]] + CEIL_PLENUM_LIFT;
      absolute[c] = 1;
      plenumCells.push(c);
    }
  }

  // --- 11. Connector shafts keep the raked soffit they were built with.
  for (let i = 0; i < openCells.length; i++) {
    const c = openCells[i];
    if (conn[c] === CONN_FLAT) continue;
    mode[c] = CEIL_MODE_CUT;
    kind[c] = CEIL_STANDARD;
    headFlat[c] = conn[c] === CONN_RAMP ? RAMP_HEADROOM : HEADROOM_SLOPE;
    absolute[c] = 1;
  }

  // --- 12. Resolve lowest ceiling per cell; enforce walk floor on organic cells.
  lvl.ceilMode = mode;
  lvl.ceilKind = kind;
  lvl.ceilHeadFlat = headFlat;
  lvl.ceilHeadLat = headLat;

  for (let i = 0; i < openCells.length; i++) {
    const c = openCells[i];
    if (mode[c] === CEIL_MODE_CUT) {
      let h = absolute[c] ? headFlat[c] : ZONE_HEADROOM[zone[c]] + headFlat[c];
      // Named chokes may go under walk-min; everything else stays standable.
      if (kind[c] === CEIL_KIND_CHOKE) {
        if (h < CEIL_MIN) h = CEIL_MIN;
      } else if (h < CEIL_WALK_MIN) {
        h = CEIL_WALK_MIN;
      }
      headFlat[c] = h;
    }
    let low = Infinity;
    for (let k = 0; k < 4; k++) {
      const y = ceilCornerY(lvl, c, k);
      if (y < low) low = y;
    }
    ceilLowY[c] = low;
  }

  lvl.ceilLowY = ceilLowY;
  lvl.atriumCells = Int32Array.from(atriumCells);
  lvl.galleryCells = Int32Array.from(galleryCells);
  lvl.vaultCells = Int32Array.from(vaultCells);
  lvl.shaftCells = Int32Array.from(shaftCells);
  lvl.plenumCells = Int32Array.from(plenumCells);
  lvl.ceilProfile = profile;
  return lvl;
}

function randRange(rng, pair) {
  if (!pair) return 0;
  return pair[0] + ((rng() * (pair[1] - pair[0] + 1)) | 0);
}

// ---------------------------------------------------------------------------
// Sampling. Used by geometry (per corner) and by gameplay (bilinear).
// ---------------------------------------------------------------------------

/** Lattice offsets for cell corners A,B,C,D = (0,0) (1,0) (1,1) (0,1). */
const LAT_DX = [0, 1, 1, 0];
const LAT_DY = [0, 0, 1, 1];

/** Clear height above the floor at corner `i` of `cell`. */
export function ceilHeadroomAt(lvl, cell, i) {
  if (lvl.ceilMode[cell] === CEIL_MODE_CUT) return lvl.ceilHeadFlat[cell];
  const cx = cell % GRID_W;
  const cy = (cell / GRID_W) | 0;
  let h = ZONE_HEADROOM[lvl.zone[cell]]
    + lvl.ceilHeadLat[(cy + LAT_DY[i]) * LAT_W + cx + LAT_DX[i]];
  // Organic loft never forces a crawl — only explicit choke cuts do that.
  if (lvl.ceilKind[cell] !== CEIL_KIND_CHOKE && h < CEIL_WALK_MIN) h = CEIL_WALK_MIN;
  if (h < CEIL_MIN) h = CEIL_MIN;
  return h;
}

/** Absolute world Y of the ceiling at corner `i` of `cell`. */
export function ceilCornerY(lvl, cell, i) {
  return cornerHu(lvl.heights, lvl.slopeDir, lvl.slopeRise, cell, i) * RISE
    + ceilHeadroomAt(lvl, cell, i);
}
