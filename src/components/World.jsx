import React, { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import {
  FOG_COLOR, FOG_DENSITY, PICKUP_COUNT, GRID_W, HZ_HUD, RISE,
  cellToWorldX, cellToWorldZ, ENTITY_SIGHT_DIST,
} from '../game/config.js';
import { generateLevel, pickSpreadCells } from '../game/maze.js';
import { player, entity, world, resetRuntime } from '../game/runtime.js';
import { setAmbience, heartbeat } from '../game/audio.js';
import LevelShell from './LevelShell.jsx';
import Props from './Props.jsx';
import Lamps from './Lamps.jsx';
import Player from './Player.jsx';
import Pickups from './Pickups.jsx';
import ExitDoor from './ExitDoor.jsx';
import Stalker from './Stalker.jsx';

/**
 * Composition root for a single run.
 *
 * The whole subtree is keyed on `runId` upstream, so starting a new run is a
 * clean unmount — every geometry, material and instance buffer built here is
 * released by its owner's effect cleanup before the replacement mounts.
 *
 * Child order matters: R3F runs useFrame callbacks in subscription order at
 * equal priority, and every priority here is 0 on purpose (any non-zero
 * priority would switch R3F to manual rendering). GameTick advances the clock,
 * Player writes the camera, then everything downstream reads a consistent
 * player position in the same frame.
 */
export default function World({ seed, active }) {
  const scene = useThree((s) => s.scene);

  const level = useMemo(() => {
    const lvl = generateLevel(seed);

    // Objective placement, far from spawn and from each other. Every candidate
    // is inside the strongly connected component, so an objective can never
    // land somewhere a one-way drop would strand the player.
    lvl.pickupCells = pickSpreadCells(lvl, PICKUP_COUNT, lvl.spawn, 8);
    lvl.exitCell = pickSpreadCells(lvl, 1, lvl.spawn, 22)[0];

    // The entity starts a long way off; it is not meant to be a spawn camper.
    lvl.entitySpawn = pickSpreadCells(lvl, 1, lvl.spawn, 26)[0];
    return lvl;
  }, [seed]);

  // Publish level pointers + reset per-run runtime BEFORE the first frame.
  useEffect(() => {
    world.grid = level.grid;
    world.openCells = level.openCells;
    // Dev-only inspection handle, alongside the one runtime.js installs. Lets
    // the generated section be walked and queried without a rebuild. Stripped
    // from the production bundle entirely.
    if (import.meta.env && import.meta.env.DEV && window.__backrooms) {
      window.__backrooms.level = level;
      window.__backrooms.scene = scene;
    }
    world.exitX = cellToWorldX(level.exitCell % GRID_W);
    world.exitZ = cellToWorldZ((level.exitCell / GRID_W) | 0);
    const pickupX = new Float32Array(PICKUP_COUNT);
    const pickupZ = new Float32Array(PICKUP_COUNT);
    for (let i = 0; i < PICKUP_COUNT; i++) {
      const c = level.pickupCells[i];
      pickupX[i] = cellToWorldX(c % GRID_W);
      pickupZ[i] = cellToWorldZ((c / GRID_W) | 0);
    }
    world.pickupX = pickupX;
    world.pickupZ = pickupZ;
    resetRuntime(
      cellToWorldX(level.spawn % GRID_W),
      cellToWorldZ((level.spawn / GRID_W) | 0),
      level.heights[level.spawn] * RISE,
    );
    return () => { world.grid = null; world.openCells = null; };
  }, [level]);

  useEffect(() => {
    const prev = scene.background;
    scene.background = new THREE.Color(FOG_COLOR);
    return () => {
      if (scene.background && scene.background.dispose) scene.background.dispose();
      scene.background = prev;
    };
  }, [scene]);

  return (
    <>
      <fogExp2 attach="fog" args={[FOG_COLOR, FOG_DENSITY]} />
      <ambientLight intensity={0.75} color={0x6a6144} />
      <hemisphereLight intensity={0.25} color={0xa39a72} groundColor={0x2a2415} />

      <GameTick />
      <Player level={level} active={active} />
      <LevelShell level={level} />
      <Props level={level} />
      <Lamps level={level} />
      <Pickups level={level} active={active} />
      <ExitDoor level={level} active={active} />
      <Stalker level={level} active={active} />
    </>
  );
}

/**
 * Global clock + dread model + audio mixing. Audio parameters are pushed at
 * HZ_HUD, not per frame: WebAudio param automation runs on its own thread and
 * re-scheduling a ramp 120x/second only adds main-thread work.
 */
function GameTick() {
  const audioAccRef = useRef(0);
  const frameCountRef = useRef(0);
  const lastTimeRef = useRef(0);

  useFrame((_, rawDelta) => {
    const delta = rawDelta > 0.25 ? 0.25 : rawDelta;
    world.elapsed += delta;

    // Accurate FPS calculation based on performance.now() clock
    frameCountRef.current++;
    const now = performance.now();
    if (lastTimeRef.current === 0) {
      lastTimeRef.current = now;
    } else {
      const elapsedSec = (now - lastTimeRef.current) / 1000;
      if (elapsedSec >= 0.25) {
        world.fps = Math.round(frameCountRef.current / elapsedSec);
        frameCountRef.current = 0;
        lastTimeRef.current = now;
      }
    }

    // Dread: proximity, awareness and darkness all feed one 0..1 scalar that
    // drives audio and the HUD vignette.
    const prox = entity.active ? Math.max(0, 1 - entity.dist / ENTITY_SIGHT_DIST) : 0;
    const seen = entity.visible ? 0.35 : 0;
    const dark = player.flashlightOn && player.battery > 0 ? 0 : 0.18;
    const target = Math.min(1, prox * (entity.hunting ? 1.25 : 0.8) + seen + dark);
    world.dangerLevel += (target - world.dangerLevel) * Math.min(1, delta * 2.5);

    heartbeat(delta, world.dangerLevel);

    audioAccRef.current += delta;
    if (audioAccRef.current >= 1 / HZ_HUD) {
      audioAccRef.current = 0;
      setAmbience(1, world.dangerLevel);
    }
  });

  return null;
}
