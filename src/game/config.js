/**
 * Central tunables. Everything here is a compile-time-ish constant so the bundler
 * can inline it and no runtime lookup chains form inside hot loops.
 */

// ---- World grid -------------------------------------------------------------
export const GRID_W = 61; // must be odd (maze carver works on odd cells)
export const GRID_H = 61;
export const CELL = 3.2; // world units per grid cell
export const HALF_W = GRID_W * 0.5;
export const HALF_H = GRID_H * 0.5;

export const CELL_COUNT = GRID_W * GRID_H;

// Texture density: world units covered by one texture tile.
export const TEX_SCALE = 2.0;
export const TEX_SCALE_HARD = 1.5; // concrete stairs/ramps tile tighter

// ---- Verticality ------------------------------------------------------------
/**
 * Elevation is stored per cell in integer HEIGHT UNITS (hu), never in world
 * units. Every landing, tread and ramp join is therefore exact integer
 * arithmetic: two cells that are meant to meet cannot drift apart by a float
 * epsilon and open a seam, and the traversal predicate is an integer compare.
 * World Y = hu * RISE.
 *
 * This is a 2.5D height field, not stacked floors: one walkable surface per
 * grid cell. That is a deliberate constraint — collision, the flow field and
 * line-of-sight all use the uniform grid itself as their acceleration
 * structure, and a per-cell layer list would turn every one of those O(1)
 * integer lookups into a list walk. Three well-separated strata joined by
 * intentional connectors buy the vertical read of a multi-storey building
 * without giving that up.
 */
export const RISE = 0.4;
export const LEVEL_STEP = 1.7; // alias for compatibility

// The three strata. Every district is assigned exactly one.
export const Z_LOWER = 0; // Lower Maintenance — sunken service level, low ceiling
export const Z_MAIN = 1; // Main Office Floor — the datum everything else reads against
export const Z_UPPER = 2; // Upper Mezzanine — a storey above the main floor

/** Floor elevation of each stratum, in hu. 0 / 3.2 / 6.4 world units. */
export const ZONE_FLOOR_HU = [0, 8, 16];
/** Clear height above each stratum's own floor. */
export const ZONE_HEADROOM = [2.45, 3.05, 2.8];

/** Split-level offset: a sub-region of a district half a flight off its datum. */
export const SPLIT_HU = 4; // 1.6 world units

// ---- Connectors -------------------------------------------------------------
/** Gradients, in hu climbed per cell of run. */
export const STAIR_RISE_HU = 4; // 1.6 over 3.2 => 26.6°, a commercial stair
export const RAMP_RISE_HU = 1; // 0.4 over 3.2 =>  7.1°, long and shallow
/** Discrete treads rendered across one stair cell. */
export const STAIR_TREADS = 8;
/** Connector shafts run under a low raked soffit, not the room ceiling. */
export const HEADROOM_SLOPE = 2.15;
/** Ramps are cut this narrow — a transitional chute, not a room. */
export const RAMP_HEADROOM = 2.05;

/** Tallest floor a cell can reach (upper stratum plus a positive split). */
export const MAX_FLOOR_HU = 20;
export const CEILING_MAX_Y = MAX_FLOOR_HU * RISE + ZONE_HEADROOM[Z_MAIN];
export const CEILING_Y = CEILING_MAX_Y;

/**
 * Largest rise a mover may cross without a connector.
 *
 * Sized against the two cases that pin it from either side: walking up a stair
 * cell must never self-block (worst case at the moment the player's capsule
 * touches the next cell is STAIR_RISE_HU * RISE * PLAYER_RADIUS / CELL = 0.21),
 * and the shallowest deliberate drop must stay one-way (SPLIT_HU * RISE = 1.6).
 */
export const STEP_UP = 0.45;
/** Integer form of the same rule, for the cell-graph traversal predicate. */
export const STEP_UP_HU = 1;

export const GRAVITY = 21.0;
/** Fall further than this and the landing reads as a hard one (audio). */
export const HARD_LANDING = 2.0;
/** Drops taller than this are never generated — every drop must be survivable. */
export const MAX_DROP_HU = 8; // 3.2 world units, one full stratum

// ---- Player -----------------------------------------------------------------
export const EYE_HEIGHT = 1.62;
export const PLAYER_RADIUS = 0.42;
export const WALK_SPEED = 3.1;
export const SPRINT_SPEED = 5.6;
export const CROUCH_SPEED = 1.5;
export const ACCEL = 42.0; // units/s^2, ground accel
export const FRICTION = 12.0;
export const MOUSE_SENSITIVITY = 0.0022;
export const PITCH_LIMIT = Math.PI * 0.5 - 0.02;

export const STAMINA_MAX = 5.0; // seconds of sprint
export const STAMINA_REGEN = 0.55; // per second
export const BATTERY_MAX = 210.0; // seconds of flashlight

// ---- Entity -----------------------------------------------------------------
export const ENTITY_SPEED_ROAM = 1.55;
export const ENTITY_SPEED_HUNT = 3.55;
export const ENTITY_KILL_DIST = 0.85;
export const ENTITY_HEAR_DIST = 13.0; // sprinting is loud
export const ENTITY_SIGHT_DIST = 22.0;
export const ENTITY_GRACE = 25.0; // seconds before it wakes up
/** Vertical separation past which the entity cannot see or reach you at all. */
export const ENTITY_VERT_CUTOFF = 2.4;

// ---- Objective --------------------------------------------------------------
export const PICKUP_COUNT = 6;
export const PICKUP_RADIUS = 1.15;
export const EXIT_RADIUS = 1.6;

// ---- Dressing ---------------------------------------------------------------
/** One prop per this many open cells. Deliberately hollow. */
export const PROP_SPARSITY = 34;
/** Minimum cell separation between two props — they must read as isolated. */
export const PROP_MIN_SEP = 4;
/** Collision radius per prop type, indexed by PROP_CHAIR / DESK / CABINET. */
export const PROP_RADIUS = [0.30, 0.62, 0.46];
/** Chance a qualifying wall face receives a door. */
export const DOOR_CHANCE = 0.055;
/** Hard rule: this share of doors is permanently locked. The rest open on a closet. */
export const DOOR_LOCKED_RATIO = 0.85;

// ---- Rendering --------------------------------------------------------------
export const FOG_DENSITY = 0.055;
export const FOG_COLOR = 0x151208;
export const DPR_MIN = 1;
export const DPR_MAX = 1.75;

/** Number of pooled point lights that follow the player around the level. */
export const LIGHT_POOL_SIZE = 4;
/** Ceiling lamps are placed on this grid stride (in cells). */
export const LAMP_STRIDE = 4;
/** The maintenance level is lit by a fraction of the panels the offices get. */
export const LAMP_KEEP_LOWER = 0.45;

// ---- Simulation throttling --------------------------------------------------
export const HZ_LIGHT_ASSIGN = 6; // pooled light reassignment
export const HZ_ENTITY_NEAR = 60;
export const HZ_ENTITY_FAR = 10;
export const HZ_HUD = 8;
export const ENTITY_NEAR_DIST = 25.0;

// ---- Grid <-> world helpers (pure scalar math, zero allocation) -------------
export function cellToWorldX(cx) {
  return (cx - HALF_W + 0.5) * CELL;
}
export function cellToWorldZ(cy) {
  return (cy - HALF_H + 0.5) * CELL;
}
export function worldToCellX(x) {
  return ((x / CELL) + HALF_W) | 0;
}
export function worldToCellY(z) {
  return ((z / CELL) + HALF_H) | 0;
}
