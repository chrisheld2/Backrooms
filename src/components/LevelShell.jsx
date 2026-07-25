import React, { useEffect, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { buildWallGeometry, buildFloorGeometry, buildSlabGeometry } from '../game/geometry.js';
import { getTextures } from '../game/textures.js';
import { CEILING_Y } from '../game/config.js';

/**
 * The entire static level: 3 meshes, 3 draw calls, 3 materials.
 *
 * MeshLambertMaterial over MeshStandardMaterial is a deliberate call. The
 * Backrooms are matte wallpaper, matte carpet and matte tile — there is no
 * metalness, no clearcoat and no environment reflection to represent, so the
 * PBR fragment shader would be paying for a BRDF nobody can see. Lambert cuts
 * the per-pixel cost roughly in half on the fill-rate-bound surfaces that cover
 * the whole screen.
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
  const ceilRef = useRef(null);

  // Built once per run. Regenerating the level remounts this component.
  const built = useMemo(() => {
    const tex = getTextures(gl.capabilities.getMaxAnisotropy());

    const wallGeo = buildWallGeometry(level.grid, level.heights, level.rampCells);
    const floorGeo = buildFloorGeometry(level.grid, level.heights, level.rampCells);
    const ceilGeo = buildSlabGeometry(CEILING_Y, false);

    const wallMat = new THREE.MeshLambertMaterial({
      map: tex.wall,
      vertexColors: true,
      side: THREE.FrontSide,
    });
    const floorMat = new THREE.MeshLambertMaterial({ map: tex.carpet });
    const ceilMat = new THREE.MeshLambertMaterial({ map: tex.ceiling });

    return { wallGeo, floorGeo, ceilGeo, wallMat, floorMat, ceilMat };
  }, [level, gl]);

  // Explicit GPU teardown. Textures are module-cached and outlive the level,
  // so they are disposed by the app shell, not here.
  useEffect(() => {
    return () => {
      built.wallGeo.dispose();
      built.floorGeo.dispose();
      built.ceilGeo.dispose();
      built.wallMat.dispose();
      built.floorMat.dispose();
      built.ceilMat.dispose();

      for (const ref of [wallRef, floorRef, ceilRef]) {
        const node = ref.current;
        if (node && node.parent) node.parent.remove(node);
      }
    };
  }, [built]);

  return (
    <>
      <mesh ref={wallRef} geometry={built.wallGeo} material={built.wallMat} matrixAutoUpdate={false} />
      <mesh ref={floorRef} geometry={built.floorGeo} material={built.floorMat} matrixAutoUpdate={false} />
      <mesh ref={ceilRef} geometry={built.ceilGeo} material={built.ceilMat} matrixAutoUpdate={false} />
    </>
  );
}
