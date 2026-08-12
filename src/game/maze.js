import {
  GRID_W, GRID_H, CELL_COUNT, CELL, RISE,
  Z_LOWER, Z_MAIN, Z_UPPER, ZONE_FLOOR_HU, ZONE_HEADROOM,
  SPLIT_HU, STAIR_RISE_HU, RAMP_RISE_HU, HEADROOM_SLOPE, RAMP_HEADROOM,
  STEP_UP_HU, MAX_DROP_HU, MAX_FLOOR_HU, PROP_SPARSITY, PROP_MIN_SEP,
  DOOR_CHANCE, DOOR_LOCKED_RATIO,
  cellToWorldX, cellToWorldZ,
} from './config.js';

/**
 * Level 0 layout generator — a three-stratum, non-linear building.
 *
 * Data-oriented: the level is a set of parallel flat typed arrays indexed by
 * cell. Every downstream system (collision, pathing, lamp placement, geometry,
 * spawn selection) reads those same buffers, so there is exactly one source of
 * truth and no per-cell object graph to walk or garbage collect.
 *
 *   grid       Uint8   1 = solid, 0 = open
 *   heights    Uint8   floor elevation in hu at the cell's DOWNHILL edge
 *   slopeDir   Uint8   0 = flat, else DIR_* of the UPHILL edge
 *   slopeRise  Uint8   hu climbed across the cell (0 when flat)
 *   conn       Uint8   CONN_FLAT | CONN_STAIR | CONN_RAMP
 *   zone       Uint8   Z_LOWER | Z_MAIN | Z_UPPER
 *   headroom   Float32 clear height above this cell's own floor
 *   pass       Uint8   4-bit mask: bit (dir-1) set => you may step that way
 *
 * Generation order matters and is load-bearing:
 *
 *   1  carve a braided maze                (plan)
 *   2  partition into districts            (massing)
 *   3  assign each district a stratum      (section)
 *   4  offset sub-regions into split-levels
 *   5  label equal-height regions
 *   6  place intentional connectors at region borders; wall or cliff the rest
 *   7  add stairs that climb into blank walls
 *   8  prune to the strongly connected component around spawn
 *   9  hang doors, 85% of them locked; carve closets behind the rest
 *  10  scatter isolated props
 *
 * Step 8 is what makes one-way drops safe: a cell survives only if the player
 * can reach it from spawn AND get back, so a drop always has a staircase
 * somewhere else, never a softlock. Running it AFTER the connectors are cut is
 * the whole point — it validates the finished circulation, not the intent.
 *
 * Generation runs ONCE per run at mount time — allocations here are fine and
 * deliberate. Nothing in this file may be called from a frame loop.
 */

// ---- Direction encoding -----------------------------------------------------
export const DIR_PX = 1;
export const DIR_NX = 2;
export const DIR_PZ = 3;
export const DIR_NZ = 4;

/** Cell-index delta for each direction. Index 0 is unused padding. */
export const DIR_OFF = [0, 1, -1, GRID_W, -GRID_W];
export const DIR_OPP = [0, DIR_NX, DIR_PX, DIR_NZ, DIR_PZ];
export const DIR_DX = [0, 1, -1, 0, 0];
export const DIR_DY = [0, 0, 0, 1, -1];
/** The two directions perpendicular to each direction. */
const DIR_PERP = [[], [DIR_PZ, DIR_NZ], [DIR_PZ, DIR_NZ], [DIR_PX, DIR_NX], [DIR_PX, DIR_NX]];

export const CONN_FLAT = 0;
export const CONN_STAIR = 1;
export const CONN_RAMP = 2;

export const PROP_CHAIR = 0;
export const PROP_DESK = 1;
export const PROP_CABINET = 2;

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
 * Floor elevation, in hu, at the edge of `cell` facing `dir`.
 *
 * This is the join primitive the whole vertical system rests on: two cells
 * connect cleanly iff the edge heights they present to each other match. A
 * stair's treads and its landing agree exactly because both sides evaluate to
 * the same integer, not because they landed within some tolerance.
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

/**
 * @returns {object} level, or null if the layout collapsed and should be retried
 */
export function generateLevel(seed) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const lvl = buildLayout((seed + attempt * 0x9e3779b1) >>> 0, false);
    if (lvl) return lvl;
  }
  // Every attempt produced a fragmented plan. Take the last one regardless —
  // the SCC prune still guarantees it is playable, just smaller than intended.
  return buildLayout(seed >>> 0, true);
}

function buildLayout(seed, force) {
  const rng = makeRng(seed);
  const grid = new Uint8Array(CELL_COUNT).fill(1);

  // --- 1. Perfect maze on odd cells (iterative DFS; no recursion, no closures)
  const stack = new Int32Array(CELL_COUNT);
  let sp = 0;

  grid[idx(1, 1)] = 0;
  stack[sp++] = idx(1, 1);

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
  for (let r = 0; r < 16; r++) {
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

  // --- 6. Flat-plan flood fill: drop anything the player could never touch.
  const spawn = pickCentralOpen(grid, rng);
  let openCells = floodOpen(grid, spawn);
  {
    const keep = new Uint8Array(CELL_COUNT);
    for (let i = 0; i < openCells.length; i++) keep[openCells[i]] = 1;
    for (let i = 0; i < CELL_COUNT; i++) if (grid[i] === 0 && keep[i] === 0) grid[i] = 1;
  }

  // --- 7. Section: districts -> strata -> split-levels.
  const heights = new Uint8Array(CELL_COUNT);
  const slopeDir = new Uint8Array(CELL_COUNT);
  const slopeRise = new Uint8Array(CELL_COUNT);
  const conn = new Uint8Array(CELL_COUNT);
  const zone = new Uint8Array(CELL_COUNT);

  const { district, districtCount } = partitionDistricts(grid, openCells, rng);
  if (districtCount < 5 && !force) return null;

  const zoneOf = assignStrata(districtCount, district[spawn], rng);
  const splitOf = carveSplitLevels(grid, openCells, district, zoneOf, rng);

  for (let i = 0; i < openCells.length; i++) {
    const c = openCells[i];
    const z = zoneOf[district[c]];
    zone[c] = z;
    heights[c] = ZONE_FLOOR_HU[z] + splitOf[c];
    conn[c] = CONN_FLAT;
  }

  // --- 8. Circulation: cut connectors, then wall or cliff every other border.
  const region = labelRegions(grid, openCells, heights);
  const connectors = [];
  placeConnectors(grid, heights, slopeDir, slopeRise, conn, zone, region, openCells, spawn, connectors, rng);
  placeDeadEndStairs(grid, heights, slopeDir, slopeRise, conn, zone, region, openCells, spawn, connectors, rng);
  sealKillingDrops(grid, heights, slopeDir, slopeRise, conn, spawn);

  // --- 9. Prune to the strongly connected component containing spawn.
  // A one-way drop is only a feature if there is a way back around; anything
  // that fails that test is filled in rather than shipped as a softlock.
  let pass = buildPassMask(grid, heights, slopeDir, slopeRise);
  const scc = stronglyConnected(grid, pass, spawn);
  let sccCount = 0;
  for (let i = 0; i < CELL_COUNT; i++) if (scc[i]) sccCount++;
  if (!force && sccCount < openCells.length * 0.42) return null;

  for (let i = 0; i < CELL_COUNT; i++) if (grid[i] === 0 && scc[i] === 0) grid[i] = 1;
  // Connector runs that lost cells to the prune are no longer coherent.
  for (let i = connectors.length - 1; i >= 0; i--) {
    const run = connectors[i];
    let intact = true;
    for (let k = 0; k < run.cells.length; k++) if (grid[run.cells[k]] !== 0) { intact = false; break; }
    if (!intact) connectors.splice(i, 1);
  }

  // --- 10. Doors (85% locked) and the closets behind the other 15%.
  const doors = [];
  const closet = new Uint8Array(CELL_COUNT);
  hangDoors(grid, heights, conn, zone, doors, closet, rng);

  // Closets joined the floor plan after the prune; they are leaves off an
  // already-connected cell at the same height, so connectivity is unchanged.
  openCells = collectOpen(grid);
  pass = buildPassMask(grid, heights, slopeDir, slopeRise);

  // --- 11. Headroom per cell: strata differ, connector shafts are tighter.
  const headroom = new Float32Array(CELL_COUNT);
  for (let i = 0; i < openCells.length; i++) {
    const c = openCells[i];
    headroom[c] = conn[c] === CONN_RAMP ? RAMP_HEADROOM
      : conn[c] === CONN_STAIR ? HEADROOM_SLOPE
        : ZONE_HEADROOM[zone[c]];
  }

  // --- 12. Sparse dressing.
  const props = scatterProps(grid, heights, conn, zone, closet, openCells, spawn, rng);

  return {
    grid, openCells, spawn, rng,
    heights, slopeDir, slopeRise, conn, zone, headroom, pass,
    district, region, closet, connectors, doors, props,
  };
}

// ---------------------------------------------------------------------------
// Massing
// ---------------------------------------------------------------------------

/**
 * Multi-source BFS from spread seeds: districts come out as geodesic Voronoi
 * cells, so each is one contiguous slab of floor plan rather than the scattered
 * blobs a random-walk would give. Districts are what later get a stratum, so
 * their size directly sets how far the player walks on one level.
 */
function partitionDistricts(grid, openCells, rng) {
  const district = new Int32Array(CELL_COUNT).fill(-1);
  const want = 10 + ((rng() * 5) | 0);
  const seeds = [];

  let guard = 0;
  while (seeds.length < want && guard++ < 8000) {
    const c = openCells[(rng() * openCells.length) | 0];
    const cx = c % GRID_W;
    const cy = (c / GRID_W) | 0;
    let ok = true;
    for (let i = 0; i < seeds.length; i++) {
      const s = seeds[i];
      if (Math.abs(cx - (s % GRID_W)) + Math.abs(cy - ((s / GRID_W) | 0)) < 9) { ok = false; break; }
    }
    if (ok) seeds.push(c);
  }

  const queue = new Int32Array(CELL_COUNT);
  let qh = 0;
  let qt = 0;
  for (let i = 0; i < seeds.length; i++) { district[seeds[i]] = i; queue[qt++] = seeds[i]; }

  while (qh < qt) {
    const c = queue[qh++];
    const d = district[c];
    for (let dir = 1; dir <= 4; dir++) {
      const n = c + DIR_OFF[dir];
      if (n < 0 || n >= CELL_COUNT) continue;
      if (!sameRow(c, n, dir)) continue;
      if (grid[n] !== 0 || district[n] >= 0) continue;
      district[n] = d;
      queue[qt++] = n;
    }
  }

  // Any cell the BFS never reached (isolated pocket) joins district 0.
  for (let i = 0; i < openCells.length; i++) if (district[openCells[i]] < 0) district[openCells[i]] = 0;
  return { district, districtCount: seeds.length };
}

/** Guards the ±1 horizontal steps against wrapping across a row boundary. */
function sameRow(c, n, dir) {
  if (dir === DIR_PX) return (n % GRID_W) === (c % GRID_W) + 1;
  if (dir === DIR_NX) return (n % GRID_W) === (c % GRID_W) - 1;
  return true;
}

/**
 * Spawn always opens on the Main Office Floor — it is the datum the player
 * learns the building against, so both other strata read as departures from it.
 */
function assignStrata(districtCount, spawnDistrict, rng) {
  const zoneOf = new Uint8Array(districtCount).fill(Z_MAIN);
  const pool = [];
  for (let i = 0; i < districtCount; i++) if (i !== spawnDistrict) pool.push(i);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
  }

  const nLower = Math.min(pool.length, Math.max(2, Math.round(pool.length * 0.34)));
  const nUpper = Math.min(pool.length - nLower, Math.max(2, Math.round(pool.length * 0.28)));
  let k = 0;
  for (let i = 0; i < nLower; i++) zoneOf[pool[k++]] = Z_LOWER;
  for (let i = 0; i < nUpper; i++) zoneOf[pool[k++]] = Z_UPPER;
  return zoneOf;
}

/**
 * Split-levels: a bite out of a district offset half a flight from its datum.
 * These are what the long shallow ramps exist to bridge — a stair would be
 * absurd for 1.6 units, and a bare step would not read as architecture.
 */
function carveSplitLevels(grid, openCells, district, zoneOf, rng) {
  const split = new Int8Array(CELL_COUNT);
  const seen = new Uint8Array(CELL_COUNT);
  const queue = new Int32Array(CELL_COUNT);

  for (let d = 0; d < zoneOf.length; d++) {
    if (rng() > 0.45) continue;

    // The lower stratum only ever splits upward — nothing sits below datum 0.
    const dir = zoneOf[d] === Z_LOWER ? 1 : rng() < 0.5 ? 1 : -1;

    let core = -1;
    for (let t = 0; t < 200; t++) {
      const c = openCells[(rng() * openCells.length) | 0];
      if (district[c] === d && !seen[c]) { core = c; break; }
    }
    if (core < 0) continue;

    const budget = 26 + ((rng() * 46) | 0);
    let qh = 0;
    let qt = 0;
    queue[qt++] = core;
    seen[core] = 1;
    let taken = 0;

    while (qh < qt && taken < budget) {
      const c = queue[qh++];
      split[c] = dir * SPLIT_HU;
      taken++;
      for (let dr = 1; dr <= 4; dr++) {
        const n = c + DIR_OFF[dr];
        if (n < 0 || n >= CELL_COUNT || !sameRow(c, n, dr)) continue;
        if (grid[n] !== 0 || seen[n] || district[n] !== d) continue;
        seen[n] = 1;
        queue[qt++] = n;
      }
    }
  }
  return split;
}

/** Connected components over open cells joined only where heights are equal. */
function labelRegions(grid, openCells, heights) {
  const region = new Int32Array(CELL_COUNT).fill(-1);
  const queue = new Int32Array(CELL_COUNT);
  let next = 0;

  for (let i = 0; i < openCells.length; i++) {
    const start = openCells[i];
    if (region[start] >= 0) continue;
    const id = next++;
    const h = heights[start];
    let qh = 0;
    let qt = 0;
    region[start] = id;
    queue[qt++] = start;
    while (qh < qt) {
      const c = queue[qh++];
      for (let dr = 1; dr <= 4; dr++) {
        const n = c + DIR_OFF[dr];
        if (n < 0 || n >= CELL_COUNT || !sameRow(c, n, dr)) continue;
        if (grid[n] !== 0 || region[n] >= 0 || heights[n] !== h) continue;
        region[n] = id;
        queue[qt++] = n;
      }
    }
  }
  return region;
}

// ---------------------------------------------------------------------------
// Circulation
// ---------------------------------------------------------------------------

/**
 * Every place two regions meet at different elevations is a decision, and the
 * three answers are the three things the brief asks for:
 *
 *   stair  — a walled flight, 4 hu per cell, for a whole stratum change
 *   ramp   — a long shallow chute, 1 hu per cell, for a split-level
 *   drop   — left as a bare cliff: passable downward only
 *   wall   — everything else, so borders read as partition walls, not cliffs
 *
 * Connectors come first and get first refusal on the cells they need; the
 * leftovers are cliffed or walled.
 */
function placeConnectors(grid, heights, slopeDir, slopeRise, conn, zone, region, openCells, spawn, connectors, rng) {
  // --- Enumerate every (low, high) adjacency, bucketed by region pair.
  const pairs = new Map();
  for (let i = 0; i < openCells.length; i++) {
    const c = openCells[i];
    for (let dir = 1; dir <= 4; dir++) {
      const n = c + DIR_OFF[dir];
      if (n < 0 || n >= CELL_COUNT || !sameRow(c, n, dir)) continue;
      if (grid[n] !== 0) continue;
      if (heights[n] <= heights[c]) continue; // enumerate each border once, uphill
      const a = region[c];
      const b = region[n];
      const key = a < b ? a * 65536 + b : b * 65536 + a;
      let list = pairs.get(key);
      if (!list) { pairs.set(key, list = []); }
      list.push(c, dir); // low cell + direction toward the high cell
    }
  }

  const reserved = new Uint8Array(CELL_COUNT);
  reserved[spawn] = 1;
  const servedRegion = new Set();

  // --- Pass 1: cut the intended connectors.
  for (const list of pairs.values()) {
    const sites = list.length >> 1;
    const want = 1 + ((rng() * 2) | 0);
    let cut = 0;
    for (let attempt = 0; attempt < sites && cut < want; attempt++) {
      const s = pickSite(list, sites, rng, attempt);
      const lo = list[s * 2];
      const dir = list[s * 2 + 1];
      if (grid[lo] !== 0 || conn[lo] !== CONN_FLAT) continue;
      const run = carveConnector(grid, heights, slopeDir, slopeRise, conn, zone, lo, dir, reserved, rng);
      if (!run) continue;
      connectors.push(run);
      servedRegion.add(region[lo]);
      servedRegion.add(region[lo + DIR_OFF[dir]]);
      cut++;
    }
  }

  // --- Pass 2: a region with no connector at all would just get pruned away.
  // Give it a second, exhaustive try before writing it off.
  for (const list of pairs.values()) {
    const sites = list.length >> 1;
    if (sites === 0) continue;
    const rA = region[list[0]];
    const rB = region[list[0] + DIR_OFF[list[1]]];
    if (servedRegion.has(rA) && servedRegion.has(rB)) continue;
    for (let s = 0; s < sites; s++) {
      const lo = list[s * 2];
      const dir = list[s * 2 + 1];
      if (grid[lo] !== 0 || conn[lo] !== CONN_FLAT) continue;
      const run = carveConnector(grid, heights, slopeDir, slopeRise, conn, zone, lo, dir, reserved, rng);
      if (!run) continue;
      connectors.push(run);
      servedRegion.add(rA);
      servedRegion.add(rB);
      break;
    }
  }

  // --- Pass 3: resolve every remaining border into a cliff or a wall.
  for (const list of pairs.values()) {
    const sites = list.length >> 1;
    for (let s = 0; s < sites; s++) {
      const lo = list[s * 2];
      const dir = list[s * 2 + 1];
      const hi = lo + DIR_OFF[dir];
      if (grid[lo] !== 0 || grid[hi] !== 0) continue;
      if (conn[lo] !== CONN_FLAT || conn[hi] !== CONN_FLAT) continue;
      if (reserved[hi] || reserved[lo]) continue;

      const drop = heights[hi] - heights[lo];
      // An unfinished floor gap: step off and you are on the level below with
      // no immediate way back. Only ever cut where the fall is survivable.
      if (drop <= MAX_DROP_HU && rng() < 0.2) continue;
      grid[hi] = 1; // partition wall, standing on the low side's floor
    }
  }
}

/** Deterministic-but-scattered site choice without allocating a shuffle. */
function pickSite(list, sites, rng, attempt) {
  if (attempt === 0) return (rng() * sites) | 0;
  return (((rng() * sites) | 0) + attempt * 7) % sites;
}

/**
 * Cuts one connector run. The run lies on the LOW side and climbs to meet the
 * high landing exactly: cell k from the top sits at (topHu - (k+1) * perCell)
 * and rises perCell across itself, so every join in the flight — tread to
 * tread, top tread to landing, bottom tread to floor — is an integer match.
 *
 * Flanks are walled, which is both the architecture (a stair has a stairwell)
 * and the invariant collision leans on: a slope can only be entered at its ends.
 */
function carveConnector(grid, heights, slopeDir, slopeRise, conn, zone, lo, dir, reserved, rng) {
  const hi = lo + DIR_OFF[dir];
  if (grid[hi] !== 0 || conn[hi] !== CONN_FLAT) return null;

  const topHu = heights[hi];
  const botHu = heights[lo];
  const delta = topHu - botHu;
  if (delta <= 0) return null;

  const type = delta === SPLIT_HU ? CONN_RAMP : CONN_STAIR;
  const perCell = type === CONN_RAMP ? RAMP_RISE_HU : STAIR_RISE_HU;
  if (delta % perCell !== 0) return null;
  const runLen = delta / perCell;
  if (runLen > 5) return null;

  // Walk back from `lo` into the low region; the whole run must be flat floor
  // at the low elevation, unclaimed, and clear of the border.
  const back = DIR_OPP[dir];
  const cells = new Int32Array(runLen);
  let c = lo;
  for (let k = 0; k < runLen; k++) {
    if (c < 0 || c >= CELL_COUNT) return null;
    if (grid[c] !== 0 || conn[c] !== CONN_FLAT || reserved[c]) return null;
    if (heights[c] !== botHu) return null;
    cells[k] = c;
    const nxt = c + DIR_OFF[back];
    if (k < runLen - 1) {
      if (nxt < 0 || nxt >= CELL_COUNT || !sameRow(c, nxt, back)) return null;
      c = nxt;
    } else {
      // The cell the run spills onto must be low, open floor — the bottom landing.
      if (nxt < 0 || nxt >= CELL_COUNT || !sameRow(c, nxt, back)) return null;
      if (grid[nxt] !== 0 || heights[nxt] !== botHu || conn[nxt] !== CONN_FLAT) return null;
      reserved[nxt] = 1;
    }
  }

  // Commit. cells[0] is the tread nearest the top landing.
  for (let k = 0; k < runLen; k++) {
    const cc = cells[k];
    heights[cc] = topHu - (k + 1) * perCell;
    slopeDir[cc] = dir;
    slopeRise[cc] = perCell;
    conn[cc] = type;
    reserved[cc] = 1;
  }
  reserved[hi] = 1;

  // Wall the flanks so the flight is a shaft, not a shelf.
  const perp = DIR_PERP[dir];
  for (let k = 0; k < runLen; k++) {
    for (let p = 0; p < 2; p++) {
      const f = cells[k] + DIR_OFF[perp[p]];
      if (f < 0 || f >= CELL_COUNT || !sameRow(cells[k], f, perp[p])) continue;
      if (reserved[f] || conn[f] !== CONN_FLAT) continue;
      grid[f] = 1;
    }
  }

  void zone; void rng;
  return { cells: Array.from(cells), dir, type, topHu, botHu };
}

/**
 * Flights that climb two storeys and end at blank wallpaper. Cut in district
 * interiors and capped afterwards, so they can never be load-bearing for
 * circulation — the disorientation is free.
 */
function placeDeadEndStairs(grid, heights, slopeDir, slopeRise, conn, zone, region, openCells, spawn, connectors, rng) {
  const want = 3 + ((rng() * 4) | 0);
  let made = 0;
  let guard = 0;

  while (made < want && guard++ < 3000) {
    const start = openCells[(rng() * openCells.length) | 0];
    if (grid[start] !== 0 || conn[start] !== CONN_FLAT || start === spawn) continue;

    const dir = 1 + ((rng() * 4) | 0);
    const runLen = 1 + ((rng() * 2) | 0);
    const baseHu = heights[start];
    // A decoy must not climb out through the top of the building envelope —
    // everything downstream sizes its buffers against MAX_FLOOR_HU.
    if (baseHu + runLen * STAIR_RISE_HU > MAX_FLOOR_HU) continue;

    // Need runLen treads plus one cell to brick up at the top.
    let c = start;
    let ok = true;
    const cells = new Int32Array(runLen);
    for (let k = 0; k <= runLen; k++) {
      if (c < 0 || c >= CELL_COUNT || grid[c] !== 0 || conn[c] !== CONN_FLAT || c === spawn) { ok = false; break; }
      if (heights[c] !== baseHu || region[c] !== region[start]) { ok = false; break; }
      if (k < runLen) cells[k] = c;
      const nxt = c + DIR_OFF[dir];
      if (nxt < 0 || nxt >= CELL_COUNT || !sameRow(c, nxt, dir)) { ok = false; break; }
      c = nxt;
    }
    if (!ok) continue;
    const cap = start + DIR_OFF[dir] * runLen;

    for (let k = 0; k < runLen; k++) {
      const cc = cells[k];
      heights[cc] = baseHu + k * STAIR_RISE_HU;
      slopeDir[cc] = dir;
      slopeRise[cc] = STAIR_RISE_HU;
      conn[cc] = CONN_STAIR;
    }
    grid[cap] = 1; // the blank wall the flight walks into

    const perp = DIR_PERP[dir];
    for (let k = 0; k < runLen; k++) {
      for (let p = 0; p < 2; p++) {
        const f = cells[k] + DIR_OFF[perp[p]];
        if (f < 0 || f >= CELL_COUNT || !sameRow(cells[k], f, perp[p])) continue;
        if (conn[f] !== CONN_FLAT || f === spawn) continue;
        grid[f] = 1;
      }
    }

    connectors.push({
      cells: Array.from(cells), dir, type: CONN_STAIR,
      topHu: baseHu + runLen * STAIR_RISE_HU, botHu: baseHu, dead: true,
    });
    made++;
    void zone;
  }
}

/**
 * Post-condition sweep: no edge anywhere may drop further than MAX_DROP_HU.
 *
 * The border passes above each decline to touch cells they do not own —
 * connector treads, reserved landings, the spawn — and every one of those
 * refusals can leave a raw cliff behind. Rather than teaching each branch to
 * clean up after itself, the invariant is asserted once here over every
 * adjacency in the finished plan. Walling can only remove open cells, so a
 * single pass is sufficient: it cannot create a new adjacency to re-check.
 */
function sealKillingDrops(grid, heights, slopeDir, slopeRise, conn, spawn) {
  for (let c = 0; c < CELL_COUNT; c++) {
    if (grid[c] !== 0) continue;
    for (let dir = 1; dir <= 4; dir++) {
      const n = c + DIR_OFF[dir];
      if (n < 0 || n >= CELL_COUNT || !sameRow(c, n, dir)) continue;
      if (grid[n] !== 0) continue;

      const a = edgeHu(heights, slopeDir, slopeRise, c, dir);
      const b = edgeHu(heights, slopeDir, slopeRise, n, DIR_OPP[dir]);
      if (a - b <= MAX_DROP_HU) continue;

      // Wall the high side, as everywhere else — the partition then stands on
      // the low floor. Never a flight or the spawn; fall back to the low side.
      const hi = conn[c] === CONN_FLAT && c !== spawn ? c
        : conn[n] === CONN_FLAT && n !== spawn ? n : -1;
      if (hi < 0) continue;
      grid[hi] = 1;
      if (hi === c) break; // this cell is gone; stop probing its other edges
    }
  }
}

// ---------------------------------------------------------------------------
// Connectivity
// ---------------------------------------------------------------------------

/**
 * Per-cell 4-bit passability mask. Baking it here turns the entity's pathing
 * question from "sample two edge heights and compare" into one array read and
 * one bit test, in a BFS that runs several times a second.
 */
export function buildPassMask(grid, heights, slopeDir, slopeRise) {
  const pass = new Uint8Array(CELL_COUNT);
  for (let c = 0; c < CELL_COUNT; c++) {
    if (grid[c] !== 0) continue;
    let m = 0;
    for (let dir = 1; dir <= 4; dir++) {
      const n = c + DIR_OFF[dir];
      if (n < 0 || n >= CELL_COUNT || !sameRow(c, n, dir)) continue;
      if (grid[n] !== 0) continue;
      const from = edgeHu(heights, slopeDir, slopeRise, c, dir);
      const to = edgeHu(heights, slopeDir, slopeRise, n, DIR_OPP[dir]);
      if (to - from <= STEP_UP_HU) m |= 1 << (dir - 1);
    }
    pass[c] = m;
  }
  return pass;
}

/**
 * The set of cells that can reach spawn AND be reached from it.
 *
 * Standard result: the induced subgraph on a strongly connected component is
 * itself strongly connected, so filling in everything outside cannot sever a
 * route between two cells that survived. That is what lets one-way drops exist
 * without ever stranding the player.
 */
function stronglyConnected(grid, pass, spawn) {
  const fwd = new Uint8Array(CELL_COUNT);
  const bwd = new Uint8Array(CELL_COUNT);
  const queue = new Int32Array(CELL_COUNT);

  let qh = 0;
  let qt = 0;
  fwd[spawn] = 1;
  queue[qt++] = spawn;
  while (qh < qt) {
    const c = queue[qh++];
    const m = pass[c];
    for (let dir = 1; dir <= 4; dir++) {
      if ((m & (1 << (dir - 1))) === 0) continue;
      const n = c + DIR_OFF[dir];
      if (fwd[n]) continue;
      fwd[n] = 1;
      queue[qt++] = n;
    }
  }

  qh = 0; qt = 0;
  bwd[spawn] = 1;
  queue[qt++] = spawn;
  while (qh < qt) {
    const c = queue[qh++];
    // Reverse edges: who can step INTO c?
    for (let dir = 1; dir <= 4; dir++) {
      const n = c + DIR_OFF[dir];
      if (n < 0 || n >= CELL_COUNT || grid[n] !== 0 || bwd[n]) continue;
      if (!sameRow(c, n, dir)) continue;
      if ((pass[n] & (1 << (DIR_OPP[dir] - 1))) === 0) continue;
      bwd[n] = 1;
      queue[qt++] = n;
    }
  }

  const out = new Uint8Array(CELL_COUNT);
  for (let i = 0; i < CELL_COUNT; i++) out[i] = fwd[i] && bwd[i] ? 1 : 0;
  return out;
}

function floodOpen(grid, from) {
  const seen = new Uint8Array(CELL_COUNT);
  const queue = new Int32Array(CELL_COUNT);
  let qh = 0;
  let qt = 0;
  seen[from] = 1;
  queue[qt++] = from;
  while (qh < qt) {
    const c = queue[qh++];
    for (let dir = 1; dir <= 4; dir++) {
      const n = c + DIR_OFF[dir];
      if (n < 0 || n >= CELL_COUNT || !sameRow(c, n, dir)) continue;
      if (grid[n] !== 0 || seen[n]) continue;
      seen[n] = 1;
      queue[qt++] = n;
    }
  }
  return queue.slice(0, qt);
}

function collectOpen(grid) {
  let n = 0;
  for (let i = 0; i < CELL_COUNT; i++) if (grid[i] === 0) n++;
  const out = new Int32Array(n);
  let k = 0;
  for (let i = 0; i < CELL_COUNT; i++) if (grid[i] === 0) out[k++] = i;
  return out;
}

// ---------------------------------------------------------------------------
// Dressing
// ---------------------------------------------------------------------------

/**
 * Office doors along the walls. DOOR_LOCKED_RATIO of them are dead slabs that
 * open onto nothing — the point is that the player cannot tell which from the
 * corridor, so every one of them costs a walk to check. The minority that do
 * open get a real closet carved behind them, which is what keeps checking them
 * from feeling pointless.
 */
function hangDoors(grid, heights, conn, zone, doors, closet, rng) {
  // --- 1. Candidate faces. At most one door per cell keeps corridors sparse.
  const cand = [];
  for (let cy = 2; cy < GRID_H - 2; cy++) {
    for (let cx = 2; cx < GRID_W - 2; cx++) {
      const c = idx(cx, cy);
      if (grid[c] !== 0 || conn[c] !== CONN_FLAT) continue;

      for (let dir = 1; dir <= 4; dir++) {
        if (rng() > DOOR_CHANCE) continue;
        const n = c + DIR_OFF[dir];
        if (n < 0 || n >= CELL_COUNT || !sameRow(c, n, dir)) continue;
        if (grid[n] !== 1) continue;

        const nx = cx + DIR_DX[dir];
        const ny = cy + DIR_DY[dir];
        if (nx < 1 || ny < 1 || nx >= GRID_W - 1 || ny >= GRID_H - 1) continue;

        cand.push({ cell: c, dir, locked: true });
        break;
      }
    }
  }

  // --- 2. The unlocked minority, drawn from the faces that can host a closet.
  //
  // These cannot be sampled out of the candidates above. A closet needs a solid
  // cell whose only open side is the doorway, and a braided plan leaves few of
  // those: about 5% of candidate faces qualify, so rolling per door and
  // falling back to locked settles near 97%, not 85%. The ratio is a stated
  // rule, so it is met by construction — enumerate the capable faces, shuffle
  // so the handful that open are spread across the building rather than
  // clustered wherever the maze happened to leave nubs, and take the quota.
  const used = new Uint8Array(CELL_COUNT);
  for (let i = 0; i < cand.length; i++) used[cand[i].cell] = 1;

  const capable = [];
  for (let cy = 2; cy < GRID_H - 2; cy++) {
    for (let cx = 2; cx < GRID_W - 2; cx++) {
      const c = idx(cx, cy);
      if (grid[c] !== 0 || conn[c] !== CONN_FLAT || used[c]) continue;
      for (let dir = 1; dir <= 4; dir++) {
        const n = c + DIR_OFF[dir];
        if (n < 0 || n >= CELL_COUNT || !sameRow(c, n, dir)) continue;
        if (!isSealedAlcove(grid, n, dir)) continue;
        capable.push({ cell: c, dir, locked: false });
        break;
      }
    }
  }
  for (let i = capable.length - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    const t = capable[i]; capable[i] = capable[j]; capable[j] = t;
  }

  // Solve for the count that makes locked/(locked + unlocked) land on target.
  const quota = Math.round((cand.length * (1 - DOOR_LOCKED_RATIO)) / DOOR_LOCKED_RATIO);
  let opened = 0;
  for (let i = 0; i < capable.length && opened < quota; i++) {
    const d = capable[i];
    const n = d.cell + DIR_OFF[d.dir];
    // Re-check: carving an earlier closet may have opened one of n's sides.
    if (!isSealedAlcove(grid, n, d.dir)) continue;

    grid[n] = 0;
    heights[n] = heights[d.cell];
    zone[n] = zone[d.cell];
    conn[n] = CONN_FLAT;
    closet[n] = 1;
    doors.push(d);
    opened++;
  }

  for (let i = 0; i < cand.length; i++) doors.push(cand[i]);
}

/** Is `n` a solid cell whose only non-solid side is the one facing `dir`? */
function isSealedAlcove(grid, n, dir) {
  if (n < 0 || n >= CELL_COUNT || grid[n] !== 1) return false;
  for (let d = 1; d <= 4; d++) {
    if (d === DIR_OPP[dir]) continue;
    const m = n + DIR_OFF[d];
    if (m < 0 || m >= CELL_COUNT || !sameRow(n, m, d)) return false;
    if (grid[m] !== 1) return false;
  }
  return true;
}

/**
 * Isolated liminal props. Density is deliberately near-zero: a room reads as
 * abandoned because of what is missing, and one chair on its side carries more
 * than twenty pieces of furniture would.
 */
function scatterProps(grid, heights, conn, zone, closet, openCells, spawn, rng) {
  const want = (openCells.length / PROP_SPARSITY) | 0;
  const taken = new Uint8Array(CELL_COUNT);
  const at = new Int32Array(CELL_COUNT).fill(-1);

  const cell = [];
  const type = [];
  const x = [];
  const z = [];
  const y = [];
  const rot = [];

  let guard = 0;
  while (cell.length < want && guard++ < 20000) {
    const c = openCells[(rng() * openCells.length) | 0];
    if (grid[c] !== 0 || conn[c] !== CONN_FLAT || c === spawn || taken[c]) continue;

    const cx = c % GRID_W;
    const cy = (c / GRID_W) | 0;

    // Isolation: nothing else within PROP_MIN_SEP cells.
    let clear = true;
    for (let oy = -PROP_MIN_SEP; oy <= PROP_MIN_SEP && clear; oy++) {
      for (let ox = -PROP_MIN_SEP; ox <= PROP_MIN_SEP; ox++) {
        const gx = cx + ox;
        const gy = cy + oy;
        if (gx < 0 || gy < 0 || gx >= GRID_W || gy >= GRID_H) continue;
        if (taken[idx(gx, gy)]) { clear = false; break; }
      }
    }
    if (!clear) continue;

    // Which walls does this cell have? Desks and cabinets want one.
    let wallDir = 0;
    const order = 1 + ((rng() * 4) | 0);
    for (let k = 0; k < 4; k++) {
      const dir = ((order + k - 1) % 4) + 1;
      const n = c + DIR_OFF[dir];
      if (n < 0 || n >= CELL_COUNT || !sameRow(c, n, dir)) continue;
      if (grid[n] === 1) { wallDir = dir; break; }
    }

    const roll = rng();
    let t;
    if (wallDir === 0) t = PROP_CHAIR;
    else t = roll < 0.34 ? PROP_CHAIR : roll < 0.7 ? PROP_DESK : PROP_CABINET;

    // A closet is the most isolated space on the floor — always dress it.
    if (closet[c] && wallDir !== 0 && rng() < 0.75) t = rng() < 0.5 ? PROP_DESK : PROP_CABINET;

    let px = cellToWorldX(cx);
    let pz = cellToWorldZ(cy);
    let yaw;

    if (t === PROP_CHAIR) {
      // Adrift in the middle of nothing, on its side.
      px += (rng() - 0.5) * CELL * 0.45;
      pz += (rng() - 0.5) * CELL * 0.45;
      yaw = rng() * Math.PI * 2;
    } else {
      // Pushed up against the wall and facing into it.
      const push = CELL * 0.30;
      px += DIR_DX[wallDir] * push;
      pz += DIR_DY[wallDir] * push;
      yaw = Math.atan2(DIR_DX[wallDir], DIR_DY[wallDir]);
    }

    taken[c] = 1;
    at[c] = cell.length;
    cell.push(c);
    type.push(t);
    x.push(px);
    z.push(pz);
    y.push(heights[c] * RISE);
    rot.push(yaw);
    void zone;
  }

  return {
    count: cell.length,
    cell: Int32Array.from(cell),
    type: Uint8Array.from(type),
    x: Float32Array.from(x),
    z: Float32Array.from(z),
    y: Float32Array.from(y),
    rot: Float32Array.from(rot),
    at,
  };
}

// ---------------------------------------------------------------------------
// Placement helpers
// ---------------------------------------------------------------------------

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
 *
 * Connector runs, closets and prop cells are excluded: an objective on a
 * staircase is unreadable, and one behind a door the player has no reason to
 * believe opens is a cruelty rather than a puzzle. Init-time only.
 */
export function pickSpreadCells(level, count, fromCell, minDist) {
  const { grid, openCells, rng, conn, closet, props } = level;
  const fx = fromCell % GRID_W;
  const fy = (fromCell / GRID_W) | 0;
  const out = new Int32Array(count);
  let found = 0;
  let guard = 0;
  const minSep = Math.max(6, ((GRID_W + GRID_H) / (count * 2)) | 0);

  while (found < count && guard++ < 40000) {
    const c = openCells[(rng() * openCells.length) | 0];
    if (grid[c] !== 0 || conn[c] !== CONN_FLAT || closet[c] || props.at[c] >= 0) continue;
    const cx = c % GRID_W;
    const cy = (c / GRID_W) | 0;
    if (Math.abs(cx - fx) + Math.abs(cy - fy) < minDist) continue;

    let ok = true;
    for (let i = 0; i < found; i++) {
      const o = out[i];
      if (Math.abs(cx - (o % GRID_W)) + Math.abs(cy - ((o / GRID_W) | 0)) < minSep) { ok = false; break; }
    }
    if (!ok) continue;
    out[found++] = c;
  }
  // Degenerate fallback: pad with any open flat cell.
  while (found < count) {
    const c = openCells[(rng() * openCells.length) | 0];
    if (conn[c] === CONN_FLAT) out[found++] = c;
  }
  return out;
}
