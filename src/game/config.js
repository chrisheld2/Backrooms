/**
 * Central tunables. Everything here is a compile-time-ish constant so the bundler
 * can inline it and no runtime lookup chains form inside hot loops.
 */

// ---- World grid -------------------------------------------------------------
export const GRID_W = 61; // must be odd (maze carver works on odd cells)
export const GRID_H = 61;
export const CELL = 3.2; // world units per grid cell
export const WALL_H = 3.0; // clear headroom above the highest floor tier
export const HALF_W = GRID_W * 0.5;
export const HALF_H = GRID_H * 0.5;

// ---- Verticality ------------------------------------------------------------
export const LEVEL_STEP = 1.7; // world-unit rise of one stair/ramp tier
export const MAX_LEVEL = 2; // highest raised-platform tier a blob can reach
// Ceiling is one flat plane for the whole level (cheap, 1 draw call). Sizing it
// off the tallest tier means lower floors get a tall, cavernous headroom and
// top-tier mezzanines get exactly WALL_H of clearance.
export const CEILING_Y = WALL_H + MAX_LEVEL * LEVEL_STEP;

export const CELL_COUNT = GRID_W * GRID_H;

// Texture density: world units covered by one texture tile.
export const TEX_SCALE = 2.0;

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

// ---- Objective --------------------------------------------------------------
export const PICKUP_COUNT = 6;
export const PICKUP_RADIUS = 1.15;
export const EXIT_RADIUS = 1.6;

// ---- Rendering --------------------------------------------------------------
export const FOG_DENSITY = 0.055;
export const FOG_COLOR = 0x151208;
export const DPR_MIN = 1;
export const DPR_MAX = 1.75;

/** Number of pooled point lights that follow the player around the level. */
export const LIGHT_POOL_SIZE = 4;
/** Ceiling lamps are placed on this grid stride (in cells). */
export const LAMP_STRIDE = 4;

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
