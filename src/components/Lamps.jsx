import React, { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import {
  CELL, RISE, LAMP_STRIDE, LIGHT_POOL_SIZE, HZ_LIGHT_ASSIGN, LAMP_KEEP_LOWER,
  Z_LOWER, cellToWorldX, cellToWorldZ, GRID_W,
} from '../game/config.js';
import { CONN_FLAT } from '../game/maze.js';
import { player, world } from '../game/runtime.js';

/**
 * Ceiling lighting.
 *
 * Two decisions carry this system:
 *
 * 1. Every lamp panel is one instance of a single InstancedMesh — hundreds of
 *    lamps, one draw call, one geometry, one material. Flicker is written into
 *    the instanceColor buffer, and only the handful of *broken* lamps get
 *    rewritten, on a throttled tick, not per frame.
 *
 * 2. There are only LIGHT_POOL_SIZE real PointLights in the scene, ever. They
 *    are recycled onto whichever lamps are currently nearest the camera at
 *    HZ_LIGHT_ASSIGN. A forward renderer recompiles and re-shades per light,
 *    so N lights over a full-screen surface is N times the fragment cost;
 *    beyond fog range the player cannot tell a real light from an unlit panel.
 *
 * Shadows are off by design. Four shadow-casting point lights would mean 24
 * cubemap face renders of the whole level per frame. The vertical gradient
 * baked into the wall vertex colors sells the contact darkening for free.
 */

// --- Module scratchpads. Never allocate inside the frame loop.
const _mat4 = new THREE.Matrix4();
const _color = new THREE.Color();

const LAMP_SIZE = CELL * 0.62;

export default function Lamps({ level }) {
  const meshRef = useRef(null);
  const lightRefs = useRef([]);

  const lamps = useMemo(() => {
    const xs = [];
    const zs = [];
    const ys = [];
    for (let i = 0; i < level.openCells.length; i++) {
      const c = level.openCells[i];
      const cx = c % GRID_W;
      const cy = (c / GRID_W) | 0;
      if (cx % LAMP_STRIDE !== 2 || cy % LAMP_STRIDE !== 2) continue;
      // Connector shafts are lit by whatever spills in from either landing.
      if (level.conn[c] !== CONN_FLAT) continue;
      // Maintenance never got the same fit-out as the floors above it.
      if (level.zone[c] === Z_LOWER && level.rng() > LAMP_KEEP_LOWER) continue;
      xs.push(cellToWorldX(cx));
      zs.push(cellToWorldZ(cy));
      // Each stratum carries its panels at its own ceiling, not one shared plane.
      ys.push(level.heights[c] * RISE + level.headroom[c]);
    }
    const count = xs.length;
    const x = new Float32Array(xs);
    const z = new Float32Array(zs);
    const y = new Float32Array(ys);

    // ~9% of lamps are on their way out. Phase is fixed per lamp so the
    // flicker pattern is stable and reproducible instead of frame-random.
    const broken = new Uint8Array(count);
    const phase = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      broken[i] = level.rng() < 0.09 ? 1 : 0;
      phase[i] = level.rng() * 100;
    }
    const brokenList = [];
    for (let i = 0; i < count; i++) if (broken[i]) brokenList.push(i);

    return { count, x, y, z, broken, phase, brokenList: new Int32Array(brokenList) };
  }, [level]);

  const built = useMemo(() => {
    // Pre-rotated so instance matrices are pure translations — no per-instance
    // quaternion work at build time and none ever at runtime.
    const geo = new THREE.PlaneGeometry(LAMP_SIZE, LAMP_SIZE);
    geo.rotateX(Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xfff4d6,
      toneMapped: false,
      fog: true,
    });
    return { geo, mat };
  }, []);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    for (let i = 0; i < lamps.count; i++) {
      _mat4.makeTranslation(lamps.x[i], lamps.y[i] - 0.02, lamps.z[i]);
      mesh.setMatrixAt(i, _mat4);
      _color.setScalar(lamps.broken[i] ? 0.35 : 1.0);
      mesh.setColorAt(i, _color);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.frustumCulled = false; // one mesh spanning the level; culling can only lose
  }, [lamps]);

  useEffect(() => {
    return () => {
      built.geo.dispose();
      built.mat.dispose();
      const mesh = meshRef.current;
      if (mesh) {
        mesh.dispose(); // releases instanceMatrix / instanceColor GPU buffers
        if (mesh.parent) mesh.parent.remove(mesh);
      }
    };
  }, [built]);

  // Throttled: light reassignment + flicker.
  const acc = useRef(0);
  const interval = 1 / HZ_LIGHT_ASSIGN;

  // Fixed-size nearest-lamp scratch, sized at pool capacity.
  const bestIdx = useMemo(() => new Int32Array(LIGHT_POOL_SIZE).fill(-1), []);
  const bestDist = useMemo(() => new Float32Array(LIGHT_POOL_SIZE).fill(Infinity), []);

  useFrame((_, delta) => {
    acc.current += delta;
    if (acc.current < interval) return;
    const dt = acc.current;
    acc.current = 0;

    const mesh = meshRef.current;
    if (!mesh) return;

    // --- Nearest-N selection by insertion into a fixed array (no sort, no alloc).
    for (let i = 0; i < LIGHT_POOL_SIZE; i++) { bestIdx[i] = -1; bestDist[i] = Infinity; }
    const px = player.x;
    const pz = player.z;
    const py = player.y;
    for (let i = 0; i < lamps.count; i++) {
      const dx = lamps.x[i] - px;
      const dz = lamps.z[i] - pz;
      // Vertical distance counts double: a panel one stratum up is nearer in
      // plan than the corridor you are actually standing in, and without this
      // the pool spends its lights on a ceiling behind a floor slab.
      const dy = (lamps.y[i] - py) * 2;
      const d2 = dx * dx + dz * dz + dy * dy;
      if (d2 > 900) continue; // 30m cull, beyond fog
      for (let s = 0; s < LIGHT_POOL_SIZE; s++) {
        if (d2 >= bestDist[s]) continue;
        for (let k = LIGHT_POOL_SIZE - 1; k > s; k--) {
          bestDist[k] = bestDist[k - 1];
          bestIdx[k] = bestIdx[k - 1];
        }
        bestDist[s] = d2;
        bestIdx[s] = i;
        break;
      }
    }

    const t = world.elapsed;
    for (let s = 0; s < LIGHT_POOL_SIZE; s++) {
      const light = lightRefs.current[s];
      if (!light) continue;
      const li = bestIdx[s];
      if (li < 0) {
        light.intensity = 0;
        continue;
      }
      light.position.set(lamps.x[li], lamps.y[li] - 0.12, lamps.z[li]);
      light.intensity = lamps.broken[li] ? flickerValue(t, lamps.phase[li]) * 9.0 : 9.0;
    }

    // --- Flicker only the broken panels; healthy ones never touch the bus.
    const list = lamps.brokenList;
    if (list.length > 0) {
      for (let i = 0; i < list.length; i++) {
        const li = list[i];
        const dx = lamps.x[li] - px;
        const dz = lamps.z[li] - pz;
        if (dx * dx + dz * dz > 1600) continue; // off-screen lamps don't need updating
        const v = 0.12 + flickerValue(t, lamps.phase[li]) * 0.88;
        _color.setScalar(v);
        mesh.setColorAt(li, _color);
      }
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }

    void dt;
  });

  return (
    <>
      <instancedMesh
        ref={meshRef}
        args={[built.geo, built.mat, lamps.count]}
        matrixAutoUpdate={false}
      />
      {Array.from({ length: LIGHT_POOL_SIZE }, (_, i) => (
        <pointLight
          key={i}
          ref={(el) => { lightRefs.current[i] = el; }}
          intensity={0}
          distance={13}
          decay={1.7}
          color={0xffeec4}
          castShadow={false}
        />
      ))}
    </>
  );
}

/** Deterministic pseudo-flicker: cheap layered sines, no RNG, no state. */
function flickerValue(t, phase) {
  const a = Math.sin((t + phase) * 27.3);
  const b = Math.sin((t + phase) * 11.7);
  const v = a * 0.5 + b * 0.5;
  return v > 0.15 ? 1 : v > -0.1 ? 0.55 : 0.08;
}
