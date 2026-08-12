import React, { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { GRID_W, EXIT_RADIUS, RISE, cellToWorldX, cellToWorldZ } from '../game/config.js';
import { player, world } from '../game/runtime.js';
import { useGame } from '../game/store.js';
import { winChord } from '../game/audio.js';

/**
 * The way out. Sealed until every crate is collected.
 *
 * The sign texture is a 128x64 canvas built once and disposed with the
 * component — small enough that a compressed asset would cost more in loader
 * plumbing than it saves in VRAM.
 */

const LOCKED = new THREE.Color(0x992211);
const OPEN = new THREE.Color(0x2bff88);

export default function ExitDoor({ level, active }) {
  const groupRef = useRef(null);
  const glowRef = useRef(null);
  const lightRef = useRef(null);
  const win = useGame((s) => s.win);
  const wonRef = useRef(false);

  const pos = useMemo(() => {
    const c = level.exitCell;
    return [cellToWorldX(c % GRID_W), cellToWorldZ((c / GRID_W) | 0), level.heights[c] * RISE];
  }, [level]);

  const built = useMemo(() => {
    const doorGeo = new THREE.BoxGeometry(1.25, 2.15, 0.14);
    const doorMat = new THREE.MeshBasicMaterial({ color: 0x0a0a0c });

    const glowGeo = new THREE.BoxGeometry(1.45, 2.32, 0.09);
    const glowMat = new THREE.MeshBasicMaterial({ color: LOCKED.clone(), toneMapped: false });

    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#04120a';
    ctx.fillRect(0, 0, 128, 64);
    ctx.fillStyle = '#7dffbe';
    ctx.font = 'bold 40px Helvetica, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('EXIT', 64, 34);
    const signTex = new THREE.CanvasTexture(canvas);
    signTex.colorSpace = THREE.SRGBColorSpace;

    const signGeo = new THREE.PlaneGeometry(0.9, 0.45);
    const signMat = new THREE.MeshBasicMaterial({ map: signTex, toneMapped: false });

    return { doorGeo, doorMat, glowGeo, glowMat, signGeo, signMat, signTex };
  }, []);

  useEffect(() => () => {
    built.doorGeo.dispose(); built.doorMat.dispose();
    built.glowGeo.dispose(); built.glowMat.dispose();
    built.signGeo.dispose(); built.signMat.dispose();
    built.signTex.dispose();
    const g = groupRef.current;
    if (g && g.parent) g.parent.remove(g);
  }, [built]);

  useEffect(() => { wonRef.current = false; }, [level]);

  useFrame(() => {
    const glow = glowRef.current;
    const light = lightRef.current;
    const open = world.exitOpen;

    if (glow) {
      // Direct color mutation on the shared material instance — no new Color
      // per frame, no React involvement.
      const pulse = 0.6 + 0.4 * Math.sin(world.elapsed * (open ? 4.2 : 1.6));
      const c = open ? OPEN : LOCKED;
      glow.material.color.setRGB(c.r * pulse, c.g * pulse, c.b * pulse);
    }
    if (light) light.intensity = open ? 8 : 2;

    if (!active || wonRef.current) return;

    const dx = pos[0] - player.x;
    const dz = pos[1] - player.z;
    if (open && dx * dx + dz * dz < EXIT_RADIUS * EXIT_RADIUS) {
      wonRef.current = true;
      winChord();
      win(world.elapsed);
    }
  });

  return (
    <group ref={groupRef} position={[pos[0], pos[2], pos[1]]}>
      <mesh ref={glowRef} geometry={built.glowGeo} material={built.glowMat} position={[0, 1.16, -0.04]} />
      <mesh geometry={built.doorGeo} material={built.doorMat} position={[0, 1.08, 0]} castShadow receiveShadow />
      <mesh geometry={built.signGeo} material={built.signMat} position={[0, 2.5, 0.02]} />
      <mesh geometry={built.signGeo} material={built.signMat} position={[0, 2.5, -0.02]} rotation={[0, Math.PI, 0]} />
      <pointLight ref={lightRef} position={[0, 2.1, 0]} intensity={2} distance={7} decay={1.6} color={0x66ffaa} />
    </group>
  );
}
