import React, { useEffect, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import {
  buildWallGeometry, buildFloorGeometry, buildHardGeometry, buildCeilingGeometry,
} from '../game/geometry.js';
import { getTextures } from '../game/textures.js';

/**
 * The entire static level: 4 meshes, 4 draw calls, 4 materials — for three
 * strata, every staircase, every ramp and every drop-off in the building.
 *
 * MeshLambertMaterial over MeshStandardMaterial is a deliberate call. The
 * Backrooms are matte wallpaper, matte carpet and matte tile — there is no
 * metalness, no clearcoat and no environment reflection to represent, so the
 * PBR fragment shader would be paying for a BRDF nobody can see. Lambert cuts
 * the per-pixel cost roughly in half on the fill-rate-bound surfaces that cover
 * the whole screen.
 *
 * The concrete mesh is not a cost the old flat level did not have: it takes the
 * maintenance stratum's floor out of the carpet buffer rather than adding to
 * it, and pays for every stair tread and ramp out of the same call.
 *
 * Frustum culling is left ON but is close to useless for the wall mesh (one
 * huge bounding sphere). That is the correct trade here: 1 always-submitted
 * draw call beats N culled ones, because the GPU is bound by fill rate and
 * fog kills the far geometry in the depth prepass anyway.
 */
export default function LevelShell({ level }) {
  const gl = useThree((s) => s.gl);
  const wallRef = useRef(null);
  const floorRef = useRef(null);
  const hardRef = useRef(null);
  const ceilRef = useRef(null);

  // Built once per run. Regenerating the level remounts this component.
  const built = useMemo(() => {
    const tex = getTextures(gl.capabilities.getMaxAnisotropy());

    const wallGeo = buildWallGeometry(level);
    const floorGeo = buildFloorGeometry(level);
    const hardGeo = buildHardGeometry(level);
    const ceilGeo = buildCeilingGeometry(level);

    const wallMat = new THREE.MeshLambertMaterial({
      map: tex.wall,
      vertexColors: true,
      side: THREE.FrontSide,
    });
    const floorMat = new THREE.MeshLambertMaterial({ map: tex.carpet, vertexColors: true });
    const hardMat = new THREE.MeshLambertMaterial({ map: tex.hard, vertexColors: true });
    const ceilMat = new THREE.MeshLambertMaterial({ map: tex.ceiling, vertexColors: true });

    return { wallGeo, floorGeo, hardGeo, ceilGeo, wallMat, floorMat, hardMat, ceilMat };
  }, [level, gl]);

  // Explicit GPU teardown. Textures are module-cached and outlive the level,
  // so they are disposed by the app shell, not here.
  useEffect(() => {
    return () => {
      built.wallGeo.dispose();
      built.floorGeo.dispose();
      built.hardGeo.dispose();
      built.ceilGeo.dispose();
      built.wallMat.dispose();
      built.floorMat.dispose();
      built.hardMat.dispose();
      built.ceilMat.dispose();

      for (const ref of [wallRef, floorRef, hardRef, ceilRef]) {
        const node = ref.current;
        if (node && node.parent) node.parent.remove(node);
      }
    };
  }, [built]);

  return (
    <>
      {/* castShadow/receiveShadow are inert (zero GPU cost) whenever the
          renderer's shadow pass is disabled — see App.jsx's realTimeShadows
          toggle, which is the single switch that turns this on or off. */}
      <mesh ref={wallRef} geometry={built.wallGeo} material={built.wallMat} matrixAutoUpdate={false} castShadow receiveShadow />
      <mesh ref={floorRef} geometry={built.floorGeo} material={built.floorMat} matrixAutoUpdate={false} receiveShadow />
      <mesh ref={hardRef} geometry={built.hardGeo} material={built.hardMat} matrixAutoUpdate={false} castShadow receiveShadow />
      <mesh ref={ceilRef} geometry={built.ceilGeo} material={built.ceilMat} matrixAutoUpdate={false} receiveShadow />
    </>
  );
}
