import React, { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import {
  GRID_W, PICKUP_COUNT, PICKUP_RADIUS, LEVEL_STEP, cellToWorldX, cellToWorldZ,
} from '../game/config.js';
import { player, world } from '../game/runtime.js';
import { pickupChime } from '../game/audio.js';

/**
 * Almond water crates. One InstancedMesh, one draw call, regardless of count.
 *
 * Collection state lives in a Uint8Array, and a collected bottle is retired by
 * writing a zero-scale matrix into the instance buffer — no scene-graph edit,
 * no geometry rebuild, no re-render.
 */

// Module scratchpads — the entire per-frame transform pipeline reuses these.
const _mat4 = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3(1, 1, 1);
const _zero = new THREE.Vector3(0, 0, 0);
const _axis = new THREE.Vector3(0, 1, 0);

export default function Pickups({ level, active }) {
  const meshRef = useRef(null);
  const taken = useMemo(() => new Uint8Array(PICKUP_COUNT), [level]);

  const spots = useMemo(() => {
    const x = new Float32Array(PICKUP_COUNT);
    const z = new Float32Array(PICKUP_COUNT);
    const y = new Float32Array(PICKUP_COUNT);
    for (let i = 0; i < PICKUP_COUNT; i++) {
      const c = level.pickupCells[i];
      x[i] = cellToWorldX(c % GRID_W);
      z[i] = cellToWorldZ((c / GRID_W) | 0);
      y[i] = level.heights[c] * LEVEL_STEP;
    }
    return { x, z, y };
  }, [level]);

  const built = useMemo(() => {
    const geo = new THREE.CylinderGeometry(0.11, 0.11, 0.3, 10, 1);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xcdf3ff,
      toneMapped: false,
      fog: true,
    });
    return { geo, mat };
  }, []);

  useEffect(() => () => {
    built.geo.dispose();
    built.mat.dispose();
    const m = meshRef.current;
    if (m) {
      m.dispose();
      if (m.parent) m.parent.remove(m);
    }
  }, [built]);

  useEffect(() => {
    taken.fill(0);
    world.collected = 0;
  }, [taken]);

  useFrame((_, delta) => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const t = world.elapsed;
    for (let i = 0; i < PICKUP_COUNT; i++) {
      if (taken[i]) continue;

      const x = spots.x[i];
      const z = spots.z[i];

      if (active) {
        const dx = x - player.x;
        const dz = z - player.z;
        if (dx * dx + dz * dz < PICKUP_RADIUS * PICKUP_RADIUS) {
          taken[i] = 1;
          world.collected++;
          if (world.collected >= world.total) world.exitOpen = true;
          pickupChime();
          _mat4.compose(_pos.set(x, -50, z), _quat.identity(), _zero);
          mesh.setMatrixAt(i, _mat4);
          continue;
        }
      }

      _pos.set(x, spots.y[i] + 0.42 + Math.sin(t * 1.7 + i) * 0.07, z);
      _quat.setFromAxisAngle(_axis, t * 0.9 + i);
      _mat4.compose(_pos, _quat, _scale);
      mesh.setMatrixAt(i, _mat4);
    }
    mesh.instanceMatrix.needsUpdate = true;
    void delta;
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[built.geo, built.mat, PICKUP_COUNT]}
      frustumCulled={false}
      matrixAutoUpdate={false}
    />
  );
}
