import React, { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import {
  GRID_W, GRID_H, ENTITY_SPEED_ROAM, ENTITY_SPEED_HUNT, ENTITY_KILL_DIST,
  ENTITY_HEAR_DIST, ENTITY_SIGHT_DIST, ENTITY_GRACE, ENTITY_NEAR_DIST,
  HZ_ENTITY_FAR, WALK_SPEED, ENTITY_VERT_CUTOFF,
  cellToWorldX, cellToWorldZ, worldToCellX, worldToCellY,
} from '../game/config.js';
import { DIR_OFF } from '../game/maze.js';
import { player, entity, world } from '../game/runtime.js';
import { hasLineOfSight, floorYAt, ceilYAt } from '../game/collision.js';
import { computeFlow, descend, stepCX, stepCY, resetFlow } from '../game/flowfield.js';
import { useGame } from '../game/store.js';
import { jumpscare } from '../game/audio.js';

/**
 * The thing that walks the halls.
 *
 * Simulation throttling: within ENTITY_NEAR_DIST it ticks every frame, because
 * you can see it and stepping artifacts would read as jitter. Past that it
 * drops to HZ_ENTITY_FAR and integrates with the accumulated dt, so its travel
 * speed is identical at either rate — only the smoothness changes, and nobody
 * is looking.
 *
 * Pathing is a shared BFS flow field (see flowfield.js), recomputed only when
 * the player crosses a cell boundary. The entity's own per-tick decision is a
 * 4-way integer comparison.
 */

const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);

const BODY_H = 1.95;

export default function Stalker({ level, active }) {
  const groupRef = useRef(null);
  const die = useGame((s) => s.die);

  // Per-run mutable AI scratch. A ref, not state — nothing here renders.
  const ai = useRef({
    tcx: 0, tcy: 0, // target cell
    lastDX: 0, lastDY: 0,
    acc: 0,
    stuck: 0,
  });

  const built = useMemo(() => {
    const bodyGeo = new THREE.CapsuleGeometry(0.33, BODY_H - 0.66, 4, 10);
    bodyGeo.translate(0, BODY_H * 0.5, 0);
    // Unlit black: a true silhouette regardless of what light it walks through,
    // and the cheapest fragment shader in the engine.
    const bodyMat = new THREE.MeshBasicMaterial({ color: 0x04040a, fog: true });

    const eyeGeo = new THREE.SphereGeometry(0.045, 8, 6);
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0xff4422, toneMapped: false, fog: true });
    return { bodyGeo, bodyMat, eyeGeo, eyeMat };
  }, []);

  useEffect(() => () => {
    built.bodyGeo.dispose();
    built.bodyMat.dispose();
    built.eyeGeo.dispose();
    built.eyeMat.dispose();
    const g = groupRef.current;
    if (g && g.parent) g.parent.remove(g);
  }, [built]);

  // Spawn placement for this run.
  useEffect(() => {
    entity.x = cellToWorldX(level.entitySpawn % GRID_W);
    entity.z = cellToWorldZ((level.entitySpawn / GRID_W) | 0);
    entity.active = false;
    entity.hunting = false;
    entity.huntTimer = 0;
    entity.dist = 999;
    ai.current.tcx = level.entitySpawn % GRID_W;
    ai.current.tcy = (level.entitySpawn / GRID_W) | 0;
    ai.current.lastDX = 0;
    ai.current.lastDY = 0;
    ai.current.acc = 0;
    resetFlow();
  }, [level]);

  useFrame((_, rawDelta) => {
    const g = groupRef.current;
    if (!g) return;

    const dxp = player.x - entity.x;
    const dzp = player.z - entity.z;
    const dist = Math.sqrt(dxp * dxp + dzp * dzp);
    entity.dist = dist;

    // Culling: hide instead of letting three re-derive a frustum test on a
    // group whose contents are far past the fog wall.
    g.visible = entity.active && dist < 34;

    if (!active) return;

    // --- Wake-up gate
    if (!entity.active) {
      if (world.elapsed > ENTITY_GRACE || world.collected > 0) entity.active = true;
      else return;
    }

    // --- Rate selection
    const near = dist < ENTITY_NEAR_DIST;
    const a = ai.current;
    a.acc += rawDelta;
    const step = near ? 0 : 1 / HZ_ENTITY_FAR;
    if (a.acc < step) return;
    const dt = a.acc > 0.25 ? 0.25 : a.acc; // clamp after a stall
    a.acc = 0;

    // --- Awareness
    // Sight is horizontal (see hasLineOfSight), so it is gated on elevation
    // separately: standing a storey above the thing genuinely does hide you,
    // which is what makes the mezzanine worth climbing to.
    const floorY = floorYAt(level, entity.x, entity.z);
    const sameLevel = Math.abs(floorY - player.feetY) < ENTITY_VERT_CUTOFF;
    const canSee = sameLevel
      && hasLineOfSight(level.grid, entity.x, entity.z, player.x, player.z, ENTITY_SIGHT_DIST);
    const heard = player.speed > WALK_SPEED * 1.15 && dist < ENTITY_HEAR_DIST && sameLevel;
    if (canSee || heard || (dist < 5 && sameLevel)) {
      entity.hunting = true;
      entity.huntTimer = 7.5;
    } else if (entity.hunting) {
      entity.huntTimer -= dt;
      if (entity.huntTimer <= 0) entity.hunting = false;
    }
    entity.visible = canSee;

    // --- Target cell selection (only when the previous waypoint is reached)
    const cx = worldToCellX(entity.x);
    const cy = worldToCellY(entity.z);
    const reached =
      Math.abs(entity.x - cellToWorldX(a.tcx)) < 0.12 &&
      Math.abs(entity.z - cellToWorldZ(a.tcy)) < 0.12;

    if (reached) {
      if (entity.hunting) {
        computeFlow(level.pass, player.cell);
        if (descend(level.pass, cx, cy)) {
          a.tcx = stepCX;
          a.tcy = stepCY;
        }
      } else {
        wander(level.pass, cx, cy, a, level.rng);
      }
      a.lastDX = a.tcx - cx;
      a.lastDY = a.tcy - cy;
    }

    // --- Integrate toward the target cell centre
    const tx = cellToWorldX(a.tcx);
    const tz = cellToWorldZ(a.tcy);
    let mx = tx - entity.x;
    let mz = tz - entity.z;
    const mLen = Math.sqrt(mx * mx + mz * mz);
    const speed = entity.hunting ? ENTITY_SPEED_HUNT : ENTITY_SPEED_ROAM;
    const travel = speed * dt;

    if (mLen <= travel || mLen < 1e-5) {
      entity.x = tx;
      entity.z = tz;
    } else {
      mx /= mLen;
      mz /= mLen;
      entity.x += mx * travel;
      entity.z += mz * travel;
      // Face travel direction. setFromAxisAngle on a scratch quaternion avoids
      // the Euler->Quaternion object churn of `rotation.y = ...` on a Group.
      _q.setFromAxisAngle(_up, Math.atan2(mx, mz));
      g.quaternion.slerp(_q, Math.min(1, dt * 6));
    }

    // --- Commit transform. Re-sampled after the move so it rides the treads
    // of a flight rather than lagging a cell behind them.
    const restY = floorYAt(level, entity.x, entity.z);
    // Unsettling glide: a slow vertical drift, no walk cycle.
    g.position.set(entity.x, restY + Math.sin(world.elapsed * 2.1) * 0.045, entity.z);

    // It follows you into the crawlspaces. Rather than clip a two-metre body
    // through a 1.3m soffit, it folds itself down to fit — which is worse.
    const clear = ceilYAt(level, entity.x, entity.z) - restY;
    const squash = clear < BODY_H + 0.1 ? Math.max(0.42, (clear - 0.1) / BODY_H) : 1;
    g.scale.set(1 + (1 - squash) * 0.35, squash, 1 + (1 - squash) * 0.35);

    // --- Contact
    if (dist < ENTITY_KILL_DIST && Math.abs(restY - player.feetY) < ENTITY_VERT_CUTOFF) {
      jumpscare();
      die('It found you.', world.elapsed);
    }
  });

  return (
    <group ref={groupRef} visible={false}>
      <mesh geometry={built.bodyGeo} material={built.bodyMat} castShadow />
      <mesh geometry={built.eyeGeo} material={built.eyeMat} position={[-0.1, BODY_H - 0.22, 0.28]} />
      <mesh geometry={built.eyeGeo} material={built.eyeMat} position={[0.1, BODY_H - 0.22, 0.28]} />
    </group>
  );
}

/**
 * Roaming: a corridor-following random walk that dislikes turning back. Keeps
 * it drifting down long halls instead of vibrating in place at a junction.
 *
 * Steps over the same passability mask the hunt uses, so a roaming entity will
 * walk off a ledge onto the level below but will never wander up one.
 */
function wander(pass, cx, cy, a, rng) {
  let bestX = cx;
  let bestY = cy;
  let bestScore = -1;

  const here = cy * GRID_W + cx;
  const mask = pass[here];

  for (let dir = 1; dir <= 4; dir++) {
    if ((mask & (1 << (dir - 1))) === 0) continue;
    const n = here + DIR_OFF[dir];
    const nx = n % GRID_W;
    const ny = (n / GRID_W) | 0;
    if (nx < 1 || ny < 1 || nx >= GRID_W - 1 || ny >= GRID_H - 1) continue;

    const dx = nx - cx;
    const dy = ny - cy;
    const reversing = dx === -a.lastDX && dy === -a.lastDY;
    const straight = dx === a.lastDX && dy === a.lastDY;
    const score = rng() + (straight ? 1.4 : 0) - (reversing ? 1.2 : 0);
    if (score > bestScore) { bestScore = score; bestX = nx; bestY = ny; }
  }
  a.tcx = bestX;
  a.tcy = bestY;
}
