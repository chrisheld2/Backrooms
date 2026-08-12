import {
  EYE_HEIGHT, STAMINA_MAX, BATTERY_MAX, PICKUP_COUNT,
} from './config.js';

/**
 * Mutable per-frame simulation state, deliberately OUTSIDE React.
 *
 * Nothing in here may be mirrored into useState/useContext. Position, stamina,
 * battery and entity proximity change every frame; routing them through React
 * would schedule a reconciliation pass 60-120x/second and re-render every
 * consumer in the tree. The DOM HUD samples this object on a throttled timer
 * instead (see useHudSync).
 */

export const player = {
  x: 0, z: 0, y: EYE_HEIGHT,
  vx: 0, vz: 0,
  // Vertical state is tracked at the FEET, not the camera: the floor under the
  // player is an exact surface (see floorYAt) and the eye is that plus a
  // smoothed crouch offset. Doing it the other way round makes stepping off a
  // mezzanine either snap or float, depending on which lerp wins.
  feetY: 0, vy: 0, grounded: true, fallStart: 0, eyeOffset: EYE_HEIGHT,
  yaw: 0, pitch: 0,
  bobPhase: 0, bobY: 0, roll: 0,
  speed: 0,
  stamina: STAMINA_MAX,
  sprinting: false,
  crouching: false,
  /** Crouched by the ceiling rather than by choice — drives the HUD cue. */
  forcedCrouch: false,
  battery: BATTERY_MAX,
  flashlightOn: true,
  cell: 0,
};

export const entity = {
  x: 0, z: 0,
  active: false,
  hunting: false,
  dist: 999,
  visible: false,
  huntTimer: 0,
};

export const world = {
  grid: null,
  openCells: null,
  elapsed: 0,
  collected: 0,
  total: PICKUP_COUNT,
  exitOpen: false,
  exitX: 0, exitZ: 0,
  dangerLevel: 0, // 0..1, drives audio + vignette
  fps: 0,
  // Minimap read-only pointers: set once per run (World.jsx / Pickups.jsx),
  // never reallocated per frame.
  pickupX: null, pickupZ: null, pickupsTaken: null,
  heights: null, conn: null, zone: null, slopeDir: null, slopeRise: null,
};

export function resetRuntime(spawnX, spawnZ, spawnFloorY = 0) {
  player.x = spawnX; player.z = spawnZ; player.y = EYE_HEIGHT + spawnFloorY;
  player.feetY = spawnFloorY; player.vy = 0; player.grounded = true;
  player.fallStart = spawnFloorY; player.eyeOffset = EYE_HEIGHT;
  player.vx = 0; player.vz = 0;
  player.yaw = 0; player.pitch = 0;
  player.bobPhase = 0; player.bobY = 0; player.roll = 0;
  player.speed = 0;
  player.stamina = STAMINA_MAX;
  player.sprinting = false; player.crouching = false;
  player.battery = BATTERY_MAX; player.flashlightOn = true;

  entity.active = false; entity.hunting = false;
  entity.dist = 999; entity.visible = false; entity.huntTimer = 0;

  world.elapsed = 0;
  world.collected = 0;
  world.exitOpen = false;
  world.dangerLevel = 0;
  world.fps = 0;
}

// ---- Input -----------------------------------------------------------------
// A fixed-shape object: no dynamic keys, so the JIT keeps it monomorphic and
// reads compile to direct slot offsets.
export const input = {
  fwd: false, back: false, left: false, right: false,
  sprint: false, crouch: false,
};

export function bindInput() {
  window.addEventListener('keydown', onKey, { passive: false });
  window.addEventListener('keyup', onKey, { passive: false });
  window.addEventListener('blur', clearInput);
  return () => {
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('keyup', onKey);
    window.removeEventListener('blur', clearInput);
  };
}

function clearInput() {
  input.fwd = false; input.back = false; input.left = false;
  input.right = false; input.sprint = false; input.crouch = false;
}

function onKey(e) {
  const down = e.type === 'keydown';
  switch (e.code) {
    case 'KeyW': case 'ArrowUp': input.fwd = down; break;
    case 'KeyS': case 'ArrowDown': input.back = down; break;
    case 'KeyA': case 'ArrowLeft': input.left = down; break;
    case 'KeyD': case 'ArrowRight': input.right = down; break;
    case 'ShiftLeft': case 'ShiftRight': input.sprint = down; break;
    case 'KeyC': case 'ControlLeft': input.crouch = down; break;
    case 'KeyF':
      if (down && !e.repeat) player.flashlightOn = !player.flashlightOn;
      break;
    default: return;
  }
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
}

// Dev-only inspection handle, declared last so every binding above it is
// initialised. Guarded by import.meta.env.DEV, so it is stripped from the
// production bundle entirely.
if (import.meta.env && import.meta.env.DEV) {
  window.__backrooms = { player, entity, world, input };
}
