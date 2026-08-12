import React, { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import {
  CELL, RISE, LAMP_STRIDE, LIGHT_POOL_SIZE, HZ_LIGHT_ASSIGN, LAMP_KEEP_LOWER,
  Z_LOWER, cellToWorldX, cellToWorldZ, GRID_W,
} from '../game/config.js';
import { CONN_FLAT } from '../game/maze.js';
import {
  CEIL_KIND_CHOKE, CEIL_KIND_ATRIUM, CEIL_KIND_SHAFT, CEIL_KIND_PLENUM,
  CEIL_KIND_GALLERY, CEIL_KIND_VAULT, CEIL_KIND_SAG,
} from '../game/ceiling.js';
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
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3(1, 1, 1);
const _quat = new THREE.Quaternion();

const LAMP_SIZE = CELL * 0.62;

// Fixture types, and how each behaves as a light source.
export const LAMP_PANEL = 0; // recessed office panel
export const LAMP_TUBE = 1; // bare strip tube, right above your head
export const LAMP_HIGHBAY = 2; // distant fitting over a cavernous room

/** Per-kind instance scale on the shared unit panel: [x, z]. */
const KIND_SCALE = [[1, 1], [1.55, 0.20], [0.72, 0.72]];
/** Per-kind pooled-light behaviour: [intensity, distance, decay]. */
const KIND_LIGHT = [[9.0, 13, 1.7], [6.0, 7.5, 2.1], [16.0, 30, 1.15]];

export default function Lamps({ level }) {
  const meshRef = useRef(null);
  const lightRefs = useRef([]);

  /**
   * Fixtures are chosen by what the ceiling above them is doing, not by a
   * uniform stride. The lighting is how the player reads a height change before
   * they can see its geometry: a buzzing tube at forehead height announces a
   * crawlspace, and a distant high-bay that fails to reach the corners
   * announces a room too big for the building to contain.
   */
  const lamps = useMemo(() => {
    const xs = [];
    const zs = [];
    const ys = [];
    const kinds = [];
    const brokenList = [];
    const broken = [];
    const phase = [];

    for (let i = 0; i < level.openCells.length; i++) {
      const c = level.openCells[i];
      const cx = c % GRID_W;
      const cy = (c / GRID_W) | 0;
      // Connector shafts are lit by whatever spills in from either landing.
      if (level.conn[c] !== CONN_FLAT) continue;

      const kindOfCeil = level.ceilKind[c];
      // A maintenance welt is unlit by definition — that is what makes it read
      // as going somewhere the building does not want you to follow.
      if (kindOfCeil === CEIL_KIND_SHAFT) continue;

      let kind;
      if (kindOfCeil === CEIL_KIND_CHOKE || kindOfCeil === CEIL_KIND_SAG) {
        // Tight runs get a fixture on every cell: nowhere to hide from them.
        kind = LAMP_TUBE;
      } else if (
        kindOfCeil === CEIL_KIND_ATRIUM
        || kindOfCeil === CEIL_KIND_GALLERY
        || kindOfCeil === CEIL_KIND_VAULT
      ) {
        // High-bays are sparse — the gaps between them are the point.
        if (cx % (LAMP_STRIDE + 2) !== 1 || cy % (LAMP_STRIDE + 2) !== 1) continue;
        kind = LAMP_HIGHBAY;
      } else {
        if (cx % LAMP_STRIDE !== 2 || cy % LAMP_STRIDE !== 2) continue;
        if (kindOfCeil === CEIL_KIND_PLENUM) continue; // the panel is what fell out
        // Maintenance never got the same fit-out as the floors above it.
        if (level.zone[c] === Z_LOWER && level.rng() > LAMP_KEEP_LOWER) continue;
        kind = LAMP_PANEL;
      }

      const idx = xs.length;
      xs.push(cellToWorldX(cx));
      zs.push(cellToWorldZ(cy));
      // Every fixture hangs from its own ceiling, which is now per-cell.
      ys.push(level.ceilLowY[c]);
      kinds.push(kind);
      // Tubes in the tight runs are the worst-maintained things in the level.
      const failRate = kind === LAMP_TUBE ? 0.42 : kind === LAMP_HIGHBAY ? 0.16 : 0.09;
      const isBroken = level.rng() < failRate ? 1 : 0;
      broken.push(isBroken);
      phase.push(level.rng() * 100);
      if (isBroken) brokenList.push(idx);
    }

    return {
      count: xs.length,
      x: new Float32Array(xs),
      y: new Float32Array(ys),
      z: new Float32Array(zs),
      kind: Uint8Array.from(kinds),
      broken: Uint8Array.from(broken),
      phase: Float32Array.from(phase),
      brokenList: new Int32Array(brokenList),
    };
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
      const s = KIND_SCALE[lamps.kind[i]];
      _pos.set(lamps.x[i], lamps.y[i] - 0.02, lamps.z[i]);
      _scale.set(s[0], 1, s[1]);
      _mat4.compose(_pos, _quat, _scale);
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
      const k = KIND_LIGHT[lamps.kind[li]];
      light.position.set(lamps.x[li], lamps.y[li] - 0.12, lamps.z[li]);
      // Throw and falloff follow the fixture: a tube pools tightly around the
      // player's head, a high-bay reaches far but decays slowly enough that it
      // never actually lifts the upper corners of the room it hangs in.
      light.distance = k[1];
      light.decay = k[2];
      light.intensity = lamps.broken[li] ? flickerValue(t, lamps.phase[li]) * k[0] : k[0];
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
