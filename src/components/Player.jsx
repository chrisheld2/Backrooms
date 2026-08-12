import React, { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  EYE_HEIGHT, PLAYER_RADIUS, WALK_SPEED, SPRINT_SPEED, CROUCH_SPEED,
  ACCEL, FRICTION, MOUSE_SENSITIVITY, PITCH_LIMIT,
  STAMINA_MAX, STAMINA_REGEN, BATTERY_MAX,
  GRAVITY, HARD_LANDING,
  worldToCellX, worldToCellY, GRID_W,
} from '../game/config.js';
import { player, input, bindInput } from '../game/runtime.js';
import { resolveCircle, hitX, hitZ, floorYAt } from '../game/collision.js';
import { footstep } from '../game/audio.js';
import { useGame } from '../game/store.js';

/**
 * First-person controller.
 *
 * The camera is mutated directly every frame. Nothing about the player's pose
 * touches React state: no useState, no context, no props flowing down. React
 * only ever learns about the player when the phase changes (death / win),
 * which is a handful of times per run.
 *
 * All math is scalar. There is not a single Vector3 or Quaternion in this file,
 * because a yaw-only movement basis is two trig calls and four multiplies —
 * building vectors for it would allocate for no gain.
 */

const MAX_DELTA = 1 / 20; // hard clamp: a stalled tab must not teleport the player

/**
 * How far the floor may sit below the feet while the player still counts as
 * standing on it. Sized to swallow a frame's worth of descent down the steepest
 * connector at sprint speed on a stalled frame (5.6 * MAX_DELTA * tan 26.6° =
 * 0.14) while staying well under the shallowest deliberate drop (1.6).
 */
const GROUND_SNAP = 0.35;

export default function Player({ level, active }) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const lightRef = useRef(null);
  const pause = useGame((s) => s.pause);
  const realTimeShadows = useGame((s) => s.visualEffects.realTimeShadows);

  // --- Input + pointer lock ---------------------------------------------------
  useEffect(() => bindInput(), []);

  useEffect(() => {
    camera.rotation.order = 'YXZ';
    const el = gl.domElement;

    function onMouseMove(e) {
      if (document.pointerLockElement !== el) return;
      player.yaw -= e.movementX * MOUSE_SENSITIVITY;
      player.pitch -= e.movementY * MOUSE_SENSITIVITY;
      if (player.pitch > PITCH_LIMIT) player.pitch = PITCH_LIMIT;
      else if (player.pitch < -PITCH_LIMIT) player.pitch = -PITCH_LIMIT;
    }

    function onLockChange() {
      if (document.pointerLockElement !== el) pause();
    }

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('pointerlockchange', onLockChange);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('pointerlockchange', onLockChange);
    };
  }, [camera, gl, pause]);

  // --- Flashlight target -------------------------------------------------------
  // A SpotLight aims at `light.target`, which must be a live member of the
  // scene graph or its world matrix never updates.
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    const light = lightRef.current;
    if (!light) return;
    const target = light.target;
    scene.add(target);
    return () => { scene.remove(target); };
  }, [scene]);

  const stepFlag = useRef(0);

  useFrame((_, rawDelta) => {
    const delta = rawDelta > MAX_DELTA ? MAX_DELTA : rawDelta;

    if (!active) {
      // Frozen (paused / dead / won) — still keep the camera authoritative so
      // the death and menu views render from the right place.
      camera.position.set(player.x, player.y + player.bobY, player.z);
      camera.rotation.set(player.pitch, player.yaw, player.roll);
      syncFlashlight(lightRef.current);
      return;
    }

    // --- Movement basis from yaw (scalar, zero allocation)
    const sinY = Math.sin(player.yaw);
    const cosY = Math.cos(player.yaw);
    const fx = -sinY;
    const fz = -cosY;
    const rx = cosY;
    const rz = -sinY;

    let wx = 0;
    let wz = 0;
    if (input.fwd) { wx += fx; wz += fz; }
    if (input.back) { wx -= fx; wz -= fz; }
    if (input.right) { wx += rx; wz += rz; }
    if (input.left) { wx -= rx; wz -= rz; }

    const wLen = Math.sqrt(wx * wx + wz * wz);
    if (wLen > 0.0001) { wx /= wLen; wz /= wLen; }

    // --- Stamina gates sprinting
    player.crouching = input.crouch;
    const wantsSprint = input.sprint && !input.crouch && wLen > 0.0001 && player.stamina > 0.05;
    player.sprinting = wantsSprint;
    if (wantsSprint) {
      player.stamina -= delta;
      if (player.stamina < 0) player.stamina = 0;
    } else if (player.stamina < STAMINA_MAX) {
      player.stamina += delta * STAMINA_REGEN;
      if (player.stamina > STAMINA_MAX) player.stamina = STAMINA_MAX;
    }

    const maxSpeed = player.crouching ? CROUCH_SPEED : wantsSprint ? SPRINT_SPEED : WALK_SPEED;

    // --- Accelerate toward the wish velocity, then apply ground friction
    const targetVX = wx * maxSpeed;
    const targetVZ = wz * maxSpeed;
    const a = ACCEL * delta;
    player.vx += (targetVX - player.vx) * (a > 1 ? 1 : a);
    player.vz += (targetVZ - player.vz) * (a > 1 ? 1 : a);

    if (wLen < 0.0001) {
      const f = 1 - Math.min(1, FRICTION * delta);
      player.vx *= f;
      player.vz *= f;
    }

    // --- Integrate + resolve against the grid
    const nextX = player.x + player.vx * delta;
    const nextZ = player.z + player.vz * delta;
    // Feet elevation is what decides whether a neighbouring cell is floor or a
    // wall this frame: below you it is a drop you may walk off, more than
    // STEP_UP above you it is unclimbable. That one comparison is the whole
    // reason a drop-off is one-way.
    resolveCircle(level, nextX, nextZ, PLAYER_RADIUS, player.feetY);

    // Kill the velocity component that was cancelled by the wall, so sliding
    // along a corridor stays smooth instead of stuttering.
    const corrX = hitX - nextX;
    const corrZ = hitZ - nextZ;
    if (corrX !== 0 || corrZ !== 0) {
      const cl = Math.sqrt(corrX * corrX + corrZ * corrZ);
      if (cl > 1e-6) {
        const nxn = corrX / cl;
        const nzn = corrZ / cl;
        const into = player.vx * nxn + player.vz * nzn;
        if (into < 0) { player.vx -= nxn * into; player.vz -= nzn * into; }
      }
    }

    player.x = hitX;
    player.z = hitZ;
    player.cell = worldToCellY(player.z) * GRID_W + worldToCellX(player.x);

    const speed = Math.sqrt(player.vx * player.vx + player.vz * player.vz);
    player.speed = speed;

    // --- Head bob + footsteps
    player.bobPhase += speed * delta * 2.05;
    const bobAmp = (wantsSprint ? 0.055 : 0.038) * Math.min(1, speed / WALK_SPEED);
    player.bobY = Math.sin(player.bobPhase * 2) * bobAmp;
    player.roll = Math.cos(player.bobPhase) * bobAmp * 0.22;

    const stepIndex = Math.floor(player.bobPhase / Math.PI);
    if (stepIndex !== stepFlag.current && speed > 0.6 && player.grounded) {
      stepFlag.current = stepIndex;
      footstep(wantsSprint);
    }

    // --- Vertical: stick to the floor, or fall off it
    //
    // The ground under the player is an exact surface — flat on a landing, a
    // true incline across a stair or ramp cell. While the gap to it is inside
    // GROUND_SNAP the player is glued to it, which covers walking up a flight,
    // walking down one, and touching down after a fall in the same branch.
    // Anything larger is a drop-off, and gravity takes over.
    const groundY = floorYAt(level, player.x, player.z);
    const gap = player.feetY - groundY;

    if (gap <= GROUND_SNAP && (player.grounded || player.vy <= 0)) {
      if (!player.grounded && player.fallStart - groundY > HARD_LANDING) footstep(true);
      player.feetY = groundY;
      player.vy = 0;
      player.grounded = true;
    } else {
      if (player.grounded) { player.grounded = false; player.fallStart = player.feetY; }
      player.vy -= GRAVITY * delta;
      player.feetY += player.vy * delta;
      if (player.feetY <= groundY) {
        if (player.fallStart - groundY > HARD_LANDING) footstep(true);
        player.feetY = groundY;
        player.vy = 0;
        player.grounded = true;
      }
    }

    // Only the crouch offset is smoothed. Smoothing the floor as well would put
    // a lag between the camera and a staircase the player is visibly on.
    const wantEye = player.crouching ? EYE_HEIGHT * 0.62 : EYE_HEIGHT;
    player.eyeOffset += (wantEye - player.eyeOffset) * Math.min(1, delta * 9);
    player.y = player.feetY + player.eyeOffset;

    // --- Flashlight battery
    if (player.flashlightOn && player.battery > 0) {
      player.battery -= delta;
      if (player.battery <= 0) { player.battery = 0; player.flashlightOn = false; }
    }

    // --- Commit to the camera (direct Object3D mutation)
    camera.position.set(player.x, player.y + player.bobY, player.z);
    camera.rotation.set(player.pitch, player.yaw, player.roll);
    syncFlashlight(lightRef.current);
  });

  return (
    <spotLight
      ref={lightRef}
      intensity={0}
      angle={0.62}
      penumbra={0.55}
      distance={24}
      decay={1.35}
      color={0xfff0cc}
      castShadow={realTimeShadows}
      shadow-mapSize={[1024, 1024]}
      shadow-bias={-0.0025}
      shadow-camera-near={0.15}
      shadow-camera-far={24}
    />
  );
}

/**
 * Pose + intensity for the flashlight, written straight onto the native light.
 * Direction is rebuilt from the two Euler scalars rather than read back from
 * the camera matrix — three multiplies beats a matrix decompose.
 */
function syncFlashlight(light) {
  if (!light) return;
  const want = player.flashlightOn && player.battery > 0;
  // Battery-dying flicker, derived from remaining charge only.
  const lowFactor = player.battery < 20 ? 0.35 + 0.65 * Math.abs(Math.sin(player.battery * 9)) : 1;
  light.intensity = want ? 30 * lowFactor : 0;
  if (!want) return;

  const cp = Math.cos(player.pitch);
  const dx = -Math.sin(player.yaw) * cp;
  const dy = Math.sin(player.pitch);
  const dz = -Math.cos(player.yaw) * cp;

  const px = player.x;
  const py = player.y + player.bobY;
  const pz = player.z;
  light.position.set(px, py, pz);
  light.target.position.set(px + dx * 10, py + dy * 10, pz + dz * 10);
  light.target.updateMatrixWorld();
}
