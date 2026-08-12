import React, { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import {
  CELL, RISE, GRID_W, cellToWorldX, cellToWorldZ,
} from '../game/config.js';
import {
  CONN_STAIR, DIR_DX, DIR_DY,
  PROP_CHAIR, PROP_DESK, PROP_CABINET, PROP_PILLAR,
  FIX_PIPE, FIX_CONDUIT, FIX_JOIST,
} from '../game/maze.js';
import {
  buildChairGeometry, buildDeskGeometry, buildCabinetGeometry,
  buildDoorLockedGeometry, buildDoorOpenGeometry, buildRailGeometry,
  buildPillarGeometry, buildPipeGeometry, buildConduitGeometry, buildJoistGeometry,
  buildPropMaterial,
} from '../game/props.js';

/**
 * Everything that dresses the level, in six instanced draw calls: three
 * furniture types, two door states and one box that becomes every handrail in
 * the building.
 *
 * All six share a single untextured vertex-coloured material. Nothing here
 * animates, so every instance matrix is written once in a mount effect and the
 * buffers are marked StaticDrawUsage — the frame loop never touches this file.
 */

// --- Module scratchpads. Written during mount only; never allocate per frame.
const _m4 = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, 'YZX');

/** How far above the flight's own surface the rail sits. */
const RAIL_H = 1.0;
const RAIL_T = 0.07;
const POST_T = 0.055;
/** Inset from the stairwell wall. */
const RAIL_INSET = 0.10;

export default function Props({ level }) {
  const chairRef = useRef(null);
  const deskRef = useRef(null);
  const cabinetRef = useRef(null);
  const pillarRef = useRef(null);
  const lockedRef = useRef(null);
  const openRef = useRef(null);
  const railRef = useRef(null);
  const pipeRef = useRef(null);
  const conduitRef = useRef(null);
  const joistRef = useRef(null);

  const built = useMemo(() => ({
    chairGeo: buildChairGeometry(),
    deskGeo: buildDeskGeometry(),
    cabinetGeo: buildCabinetGeometry(),
    pillarGeo: buildPillarGeometry(),
    lockedGeo: buildDoorLockedGeometry(),
    openGeo: buildDoorOpenGeometry(),
    railGeo: buildRailGeometry(),
    pipeGeo: buildPipeGeometry(),
    conduitGeo: buildConduitGeometry(),
    joistGeo: buildJoistGeometry(),
    mat: buildPropMaterial(),
  }), []);

  // Per-type instance counts, resolved once from the generated level.
  const counts = useMemo(() => {
    const props = level.props;
    let chair = 0;
    let desk = 0;
    let cabinet = 0;
    let pillar = 0;
    for (let i = 0; i < props.count; i++) {
      const t = props.type[i];
      if (t === PROP_CHAIR) chair++;
      else if (t === PROP_DESK) desk++;
      else if (t === PROP_CABINET) cabinet++;
      else pillar++;
    }

    const fx = level.fixtures;
    let pipe = 0;
    let conduit = 0;
    let joist = 0;
    for (let i = 0; i < fx.count; i++) {
      const t = fx.type[i];
      if (t === FIX_PIPE) pipe++;
      else if (t === FIX_CONDUIT) conduit++;
      else joist++;
    }

    let locked = 0;
    for (let i = 0; i < level.doors.length; i++) if (level.doors[i].locked) locked++;

    // 2 rails + 4 posts per stair cell; segments meet flush at cell borders
    // because adjacent treads share an exact edge elevation.
    let stairCells = 0;
    for (let i = 0; i < level.connectors.length; i++) {
      const run = level.connectors[i];
      if (run.type === CONN_STAIR) stairCells += run.cells.length;
    }

    return {
      chair, desk, cabinet, pillar,
      locked, open: level.doors.length - locked,
      rail: stairCells * 6,
      pipe, conduit, joist,
    };
  }, [level]);

  // --- Furniture and columns ---------------------------------------------------
  useEffect(() => {
    const props = level.props;
    const cursors = { [PROP_CHAIR]: 0, [PROP_DESK]: 0, [PROP_CABINET]: 0, [PROP_PILLAR]: 0 };
    const meshes = {
      [PROP_CHAIR]: chairRef.current,
      [PROP_DESK]: deskRef.current,
      [PROP_CABINET]: cabinetRef.current,
      [PROP_PILLAR]: pillarRef.current,
    };

    for (let i = 0; i < props.count; i++) {
      const mesh = meshes[props.type[i]];
      if (!mesh) continue;
      _pos.set(props.x[i], props.y[i], props.z[i]);
      _euler.set(0, props.rot[i], 0);
      _quat.setFromEuler(_euler);
      // Columns are unit-tall and stretched to reach their own patch of soffit.
      _scale.set(1, props.scaleY[i], 1);
      _m4.compose(_pos, _quat, _scale);
      mesh.setMatrixAt(cursors[props.type[i]]++, _m4);
    }

    for (const key in meshes) {
      const mesh = meshes[key];
      if (!mesh) continue;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      mesh.frustumCulled = false; // one mesh spanning the level; culling can only lose
    }
  }, [level, counts]);

  // --- Doors ------------------------------------------------------------------
  useEffect(() => {
    const lockedMesh = lockedRef.current;
    const openMesh = openRef.current;
    let li = 0;
    let oi = 0;

    for (let i = 0; i < level.doors.length; i++) {
      const d = level.doors[i];
      const cx = d.cell % GRID_W;
      const cy = (d.cell / GRID_W) | 0;
      // Stand the frame just shy of the wall plane so it reads as proud of the
      // wallpaper rather than co-planar with it.
      const off = CELL * 0.5 - 0.04;
      _pos.set(
        cellToWorldX(cx) + DIR_DX[d.dir] * off,
        level.heights[d.cell] * RISE,
        cellToWorldZ(cy) + DIR_DY[d.dir] * off,
      );
      // Local +Z points at the wall this door is hung on.
      _euler.set(0, Math.atan2(DIR_DX[d.dir], DIR_DY[d.dir]), 0);
      _quat.setFromEuler(_euler);
      _scale.set(1, 1, 1);
      _m4.compose(_pos, _quat, _scale);

      if (d.locked) { if (lockedMesh) lockedMesh.setMatrixAt(li++, _m4); }
      else if (openMesh) openMesh.setMatrixAt(oi++, _m4);
    }

    for (const mesh of [lockedMesh, openMesh]) {
      if (!mesh) continue;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      mesh.frustumCulled = false;
    }
  }, [level, counts]);

  // --- Handrails --------------------------------------------------------------
  useEffect(() => {
    const mesh = railRef.current;
    if (!mesh) return;
    let n = 0;

    for (let r = 0; r < level.connectors.length; r++) {
      const run = level.connectors[r];
      if (run.type !== CONN_STAIR) continue;

      const dir = run.dir;
      const hx = DIR_DX[dir];
      const hz = DIR_DY[dir];
      // Perpendicular, for the two flanks of the stairwell.
      const px = -hz;
      const pz = hx;

      for (let k = 0; k < run.cells.length; k++) {
        const c = run.cells[k];
        const base = level.heights[c] * RISE;
        const top = (level.heights[c] + level.slopeRise[c]) * RISE;
        const cx = c % GRID_W;
        const cy = (c / GRID_W) | 0;
        const midX = cellToWorldX(cx);
        const midZ = cellToWorldZ(cy);

        const half = CELL * 0.5;
        const lowX = midX - hx * half;
        const lowZ = midZ - hz * half;
        const rise = top - base;
        const len = Math.sqrt(CELL * CELL + rise * rise);
        const pitch = Math.atan2(rise, CELL);
        const yaw = Math.atan2(-hz, hx);

        for (let side = -1; side <= 1; side += 2) {
          const ox = px * side * (half - RAIL_INSET);
          const oz = pz * side * (half - RAIL_INSET);

          // The rail itself: a box along local +X, yawed onto the run axis and
          // pitched up to match the flight.
          _pos.set(midX + ox, (base + top) * 0.5 + RAIL_H, midZ + oz);
          _euler.set(0, yaw, pitch);
          _quat.setFromEuler(_euler);
          _scale.set(len, RAIL_T, RAIL_T);
          _m4.compose(_pos, _quat, _scale);
          mesh.setMatrixAt(n++, _m4);

          // Two posts per cell, standing off the tread they sit on.
          for (let p = 0; p < 2; p++) {
            const t = p === 0 ? 0.25 : 0.75;
            const surfaceY = base + rise * t;
            _pos.set(
              lowX + hx * CELL * t + ox,
              surfaceY + RAIL_H * 0.5,
              lowZ + hz * CELL * t + oz,
            );
            _euler.set(0, yaw, 0);
            _quat.setFromEuler(_euler);
            _scale.set(POST_T, RAIL_H, POST_T);
            _m4.compose(_pos, _quat, _scale);
            mesh.setMatrixAt(n++, _m4);
          }
        }
      }
    }

    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    mesh.frustumCulled = false;
  }, [level, counts]);

  // --- Ceiling services --------------------------------------------------------
  useEffect(() => {
    const fx = level.fixtures;
    const cursors = { [FIX_PIPE]: 0, [FIX_CONDUIT]: 0, [FIX_JOIST]: 0 };
    const meshes = {
      [FIX_PIPE]: pipeRef.current,
      [FIX_CONDUIT]: conduitRef.current,
      [FIX_JOIST]: joistRef.current,
    };

    for (let i = 0; i < fx.count; i++) {
      const mesh = meshes[fx.type[i]];
      if (!mesh) continue;
      _pos.set(fx.x[i], fx.y[i], fx.z[i]);
      _euler.set(0, fx.rot[i], 0);
      _quat.setFromEuler(_euler);
      _scale.set(1, 1, 1);
      _m4.compose(_pos, _quat, _scale);
      mesh.setMatrixAt(cursors[fx.type[i]]++, _m4);
    }

    for (const key in meshes) {
      const mesh = meshes[key];
      if (!mesh) continue;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      mesh.frustumCulled = false;
    }
  }, [level, counts]);

  // --- Explicit GPU teardown ---------------------------------------------------
  useEffect(() => () => {
    for (const key in built) {
      const res = built[key];
      if (res && res.dispose) res.dispose();
    }

    for (const ref of [
      chairRef, deskRef, cabinetRef, pillarRef,
      lockedRef, openRef, railRef,
      pipeRef, conduitRef, joistRef,
    ]) {
      const mesh = ref.current;
      if (!mesh) continue;
      mesh.dispose(); // releases the instanceMatrix GPU buffer
      if (mesh.parent) mesh.parent.remove(mesh);
    }
  }, [built]);

  return (
    <>
      {counts.chair > 0 && (
        <instancedMesh ref={chairRef} args={[built.chairGeo, built.mat, counts.chair]} matrixAutoUpdate={false} />
      )}
      {counts.desk > 0 && (
        <instancedMesh ref={deskRef} args={[built.deskGeo, built.mat, counts.desk]} matrixAutoUpdate={false} />
      )}
      {counts.cabinet > 0 && (
        <instancedMesh ref={cabinetRef} args={[built.cabinetGeo, built.mat, counts.cabinet]} matrixAutoUpdate={false} />
      )}
      {counts.locked > 0 && (
        <instancedMesh ref={lockedRef} args={[built.lockedGeo, built.mat, counts.locked]} matrixAutoUpdate={false} />
      )}
      {counts.open > 0 && (
        <instancedMesh ref={openRef} args={[built.openGeo, built.mat, counts.open]} matrixAutoUpdate={false} />
      )}
      {counts.pillar > 0 && (
        <instancedMesh ref={pillarRef} args={[built.pillarGeo, built.mat, counts.pillar]} matrixAutoUpdate={false} castShadow />
      )}
      {counts.rail > 0 && (
        <instancedMesh ref={railRef} args={[built.railGeo, built.mat, counts.rail]} matrixAutoUpdate={false} />
      )}
      {counts.pipe > 0 && (
        <instancedMesh ref={pipeRef} args={[built.pipeGeo, built.mat, counts.pipe]} matrixAutoUpdate={false} />
      )}
      {counts.conduit > 0 && (
        <instancedMesh ref={conduitRef} args={[built.conduitGeo, built.mat, counts.conduit]} matrixAutoUpdate={false} />
      )}
      {counts.joist > 0 && (
        <instancedMesh ref={joistRef} args={[built.joistGeo, built.mat, counts.joist]} matrixAutoUpdate={false} />
      )}
    </>
  );
}
