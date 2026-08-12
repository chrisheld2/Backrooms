import React, { useEffect, useRef, useState } from 'react';
import { CELL, GRID_W, GRID_H, HALF_W, HALF_H, HZ_HUD } from '../game/config.js';
import { CONN_STAIR, CONN_RAMP, DIR_PX, DIR_NX, DIR_PZ, DIR_NZ } from '../game/grid.js';
import { Z_LOWER, Z_MAIN, Z_UPPER } from '../game/config.js';
import { player, entity, world } from '../game/runtime.js';
import { useGame } from '../game/store.js';

// Cells of the grid visible across the minimap's diameter, centered on the
// player. Odd so the player cell sits dead center.
const RADIUS = 13;
const SPAN = RADIUS * 2 + 1;
const PX = 200; // CSS pixel size of the canvas, square

function createPatternCanvases() {
  if (typeof document === 'undefined') return null;

  // Level 0 (Lower Maintenance): Cool dots stipple
  const c0 = document.createElement('canvas');
  c0.width = 8; c0.height = 8;
  const ctx0 = c0.getContext('2d');
  ctx0.fillStyle = 'rgba(140, 210, 255, 0.16)';
  ctx0.fillRect(1, 1, 2, 2);
  ctx0.fillRect(5, 5, 2, 2);

  // Level 1 (Main Office): Carpet grid cross-hatch
  const c1 = document.createElement('canvas');
  c1.width = 8; c1.height = 8;
  const ctx1 = c1.getContext('2d');
  ctx1.strokeStyle = 'rgba(40, 30, 10, 0.16)';
  ctx1.lineWidth = 1;
  ctx1.beginPath();
  ctx1.moveTo(0, 4); ctx1.lineTo(8, 4);
  ctx1.moveTo(4, 0); ctx1.lineTo(4, 8);
  ctx1.stroke();

  // Level 2 (Upper Mezzanine): Diagonal stripe texture
  const c2 = document.createElement('canvas');
  c2.width = 8; c2.height = 8;
  const ctx2 = c2.getContext('2d');
  ctx2.strokeStyle = 'rgba(255, 240, 210, 0.25)';
  ctx2.lineWidth = 1.5;
  ctx2.beginPath();
  ctx2.moveTo(0, 8); ctx2.lineTo(8, 0);
  ctx2.stroke();

  return { c0, c1, c2 };
}

/**
 * Translucent top-down minimap, toggled with M.
 * Displays level floor colors, level textures, stair treads, and directional indicators.
 */
export default function Minimap() {
  const phase = useGame((s) => s.phase);
  const [visible, setVisible] = useState(true);
  const [levelText, setLevelText] = useState('LVL 1 • MAIN');
  const canvasRef = useRef(null);
  const dprRef = useRef(Math.min(window.devicePixelRatio || 1, 2));
  const patternsRef = useRef(null);

  useEffect(() => {
    function onKey(e) {
      if (e.code === 'KeyM' && !e.repeat) setVisible((v) => !v);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = dprRef.current;
    canvas.width = PX * dpr;
    canvas.height = PX * dpr;
  }, []);

  useEffect(() => {
    if (phase !== 'playing' || !visible) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = dprRef.current;
    const cell = (PX * dpr) / SPAN;

    // Cache canvas pattern textures once ctx is ready
    if (!patternsRef.current && ctx) {
      const canvases = createPatternCanvases();
      if (canvases) {
        patternsRef.current = {
          p0: ctx.createPattern(canvases.c0, 'repeat'),
          p1: ctx.createPattern(canvases.c1, 'repeat'),
          p2: ctx.createPattern(canvases.c2, 'repeat'),
        };
      }
    }

    const id = setInterval(() => {
      const grid = world.grid;
      if (!grid) return;

      const playerGX = player.x / CELL + HALF_W;
      const playerGY = player.z / CELL + HALF_H;
      const originX = Math.floor(playerGX - RADIUS - 0.5);
      const originY = Math.floor(playerGY - RADIUS - 0.5);

      const toMapX = (worldX) => canvas.width * 0.5 + ((worldX / CELL + HALF_W) - playerGX) * cell;
      const toMapY = (worldZ) => canvas.height * 0.5 + ((worldZ / CELL + HALF_H) - playerGY) * cell;

      // Update current player level badge
      const pGX = Math.floor(playerGX);
      const pGY = Math.floor(playerGY);
      if (pGX >= 0 && pGX < GRID_W && pGY >= 0 && pGY < GRID_H) {
        const pCell = pGY * GRID_W + pGX;
        const pZone = world.zone && world.zone[pCell] !== undefined ? world.zone[pCell] : Z_MAIN;
        let newLabel = 'LVL 1 • MAIN';
        if (pZone === Z_LOWER) newLabel = 'LVL 0 • LOWER';
        else if (pZone === Z_UPPER) newLabel = 'LVL 2 • UPPER';
        setLevelText((prev) => (prev !== newLabel ? newLabel : prev));
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Render walls, floor levels (color-coded + textures), stairs & ramps
      for (let gy = 0; gy < SPAN; gy++) {
        const cy = originY + gy;
        if (cy < 0 || cy >= GRID_H) continue;
        for (let gx = 0; gx < SPAN; gx++) {
          const cx = originX + gx;
          if (cx < 0 || cx >= GRID_W) continue;
          const cIdx = cy * GRID_W + cx;
          const open = grid[cIdx] === 0;

          const x = canvas.width * 0.5 + (cx + 0.5 - playerGX) * cell;
          const y = canvas.height * 0.5 + (cy + 0.5 - playerGY) * cell;
          const rx = x - cell * 0.5;
          const ry = y - cell * 0.5;
          const rw = cell + 0.5;
          const rh = cell + 0.5;

          if (!open) {
            ctx.fillStyle = 'rgba(10, 9, 6, 0.65)';
            ctx.fillRect(rx, ry, rw, rh);
            continue;
          }

          const connType = world.conn ? world.conn[cIdx] : 0;
          const zone = world.zone ? world.zone[cIdx] : Z_MAIN;
          const height = world.heights ? world.heights[cIdx] : 8;

          if (connType === CONN_STAIR) {
            // ---- Stair cell ----
            // 1. Base highlight fill
            ctx.fillStyle = 'rgba(255, 195, 45, 0.70)';
            ctx.fillRect(rx, ry, rw, rh);

            // 2. Stair step treads perpendicular to ascent direction
            const sDir = world.slopeDir ? world.slopeDir[cIdx] : DIR_PX;
            ctx.strokeStyle = 'rgba(30, 20, 0, 0.6)';
            ctx.lineWidth = Math.max(1, Math.round(dpr));

            if (sDir === DIR_PZ || sDir === DIR_NZ) {
              // N-S run: horizontal tread lines
              for (let t = 1; t <= 4; t++) {
                const ty = ry + (rh * t) / 5;
                ctx.beginPath();
                ctx.moveTo(rx, ty);
                ctx.lineTo(rx + rw, ty);
                ctx.stroke();
              }
            } else {
              // E-W run: vertical tread lines
              for (let t = 1; t <= 4; t++) {
                const tx = rx + (rw * t) / 5;
                ctx.beginPath();
                ctx.moveTo(tx, ry);
                ctx.lineTo(tx, ry + rh);
                ctx.stroke();
              }
            }

            // 3. Ascending directional arrow pointing uphill
            ctx.save();
            ctx.translate(x, y);
            if (sDir === DIR_PX) ctx.rotate(0);
            else if (sDir === DIR_NX) ctx.rotate(Math.PI);
            else if (sDir === DIR_PZ) ctx.rotate(Math.PI * 0.5);
            else if (sDir === DIR_NZ) ctx.rotate(-Math.PI * 0.5);

            ctx.fillStyle = '#1c1200';
            ctx.beginPath();
            ctx.moveTo(cell * 0.28, 0);
            ctx.lineTo(-cell * 0.2, -cell * 0.22);
            ctx.lineTo(-cell * 0.08, 0);
            ctx.lineTo(-cell * 0.2, cell * 0.22);
            ctx.closePath();
            ctx.fill();
            ctx.restore();

          } else if (connType === CONN_RAMP) {
            // ---- Ramp cell ----
            ctx.fillStyle = 'rgba(70, 190, 210, 0.58)';
            ctx.fillRect(rx, ry, rw, rh);

            const sDir = world.slopeDir ? world.slopeDir[cIdx] : DIR_PX;
            ctx.save();
            ctx.translate(x, y);
            if (sDir === DIR_PX) ctx.rotate(0);
            else if (sDir === DIR_NX) ctx.rotate(Math.PI);
            else if (sDir === DIR_PZ) ctx.rotate(Math.PI * 0.5);
            else if (sDir === DIR_NZ) ctx.rotate(-Math.PI * 0.5);

            ctx.strokeStyle = '#05343d';
            ctx.lineWidth = Math.max(1, dpr);
            ctx.beginPath();
            ctx.moveTo(-cell * 0.15, -cell * 0.2);
            ctx.lineTo(cell * 0.1, 0);
            ctx.lineTo(-cell * 0.15, cell * 0.2);
            ctx.stroke();
            ctx.restore();

          } else {
            // ---- Standard Level Floor Cell ----
            let baseColor;
            let pattern;

            if (zone === Z_LOWER) {
              const isSplit = height !== 0;
              baseColor = isSplit ? 'rgba(65, 120, 165, 0.48)' : 'rgba(42, 85, 125, 0.42)';
              pattern = patternsRef.current?.p0;
            } else if (zone === Z_UPPER) {
              const isSplit = height !== 16;
              baseColor = isSplit ? 'rgba(235, 145, 60, 0.50)' : 'rgba(215, 120, 45, 0.42)';
              pattern = patternsRef.current?.p2;
            } else {
              const isSplit = height !== 8;
              baseColor = isSplit ? 'rgba(235, 222, 140, 0.38)' : 'rgba(216, 207, 154, 0.28)';
              pattern = patternsRef.current?.p1;
            }

            ctx.fillStyle = baseColor;
            ctx.fillRect(rx, ry, rw, rh);

            if (pattern) {
              ctx.fillStyle = pattern;
              ctx.fillRect(rx, ry, rw, rh);
            }
          }
        }
      }

      // Pickups (dim once collected)
      const px = world.pickupX;
      const pz = world.pickupZ;
      const taken = world.pickupsTaken;
      if (px && pz) {
        for (let i = 0; i < px.length; i++) {
          if (taken && taken[i]) continue;
          const x = toMapX(px[i]);
          const y = toMapY(pz[i]);
          if (x < 0 || x >= canvas.width || y < 0 || y >= canvas.height) continue;
          ctx.fillStyle = '#cdf3ff';
          ctx.beginPath();
          ctx.arc(x, y, cell * 0.28, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Exit, once unlocked
      if (world.exitOpen) {
        const x = toMapX(world.exitX);
        const y = toMapY(world.exitZ);
        if (x >= 0 && x < canvas.width && y >= 0 && y < canvas.height) {
          ctx.fillStyle = '#7be07b';
          ctx.beginPath();
          ctx.arc(x, y, cell * 0.34, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Entity, only while actively hunting and known to be near
      if (entity.active && entity.hunting) {
        const x = toMapX(entity.x);
        const y = toMapY(entity.z);
        if (x >= 0 && x < canvas.width && y >= 0 && y < canvas.height) {
          ctx.fillStyle = '#c8452e';
          ctx.beginPath();
          ctx.arc(x, y, cell * 0.32, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Player, always centered, with a distinct multi-colored direction arrow pointer.
      const cx = canvas.width * 0.5;
      const cyp = canvas.height * 0.5;
      const yaw = player.yaw;
      const r = cell * 0.62; // Fixed radius scale for constant rotation proportions

      ctx.save();
      ctx.translate(cx, cyp);
      ctx.rotate(-yaw);

      // Subtle drop shadow for depth and separation from floor patterns
      ctx.shadowColor = 'rgba(0, 0, 0, 0.65)';
      ctx.shadowBlur = 4 * dpr;

      // Left wing half (bright gold)
      ctx.fillStyle = '#ffe28a';
      ctx.beginPath();
      ctx.moveTo(0, -r);
      ctx.lineTo(0, r * 0.3);
      ctx.lineTo(-r * 0.55, r * 0.65);
      ctx.closePath();
      ctx.fill();

      // Right wing half (shaded gold for 3D depth)
      ctx.fillStyle = '#dca832';
      ctx.beginPath();
      ctx.moveTo(0, -r);
      ctx.lineTo(r * 0.55, r * 0.65);
      ctx.lineTo(0, r * 0.3);
      ctx.closePath();
      ctx.fill();

      // Front Nose / Tip Cap (Distinct Electric Cyan front tip)
      ctx.fillStyle = '#00f0ff';
      ctx.beginPath();
      ctx.moveTo(0, -r);
      ctx.lineTo(r * 0.26, -r * 0.28);
      ctx.lineTo(0, -r * 0.12);
      ctx.lineTo(-r * 0.26, -r * 0.28);
      ctx.closePath();
      ctx.fill();

      // Crisp dark border outline around entire arrow
      ctx.shadowColor = 'transparent';
      ctx.strokeStyle = 'rgba(10, 8, 4, 0.9)';
      ctx.lineWidth = Math.max(1, 1.2 * dpr);
      ctx.beginPath();
      ctx.moveTo(0, -r);
      ctx.lineTo(r * 0.55, r * 0.65);
      ctx.lineTo(0, r * 0.3);
      ctx.lineTo(-r * 0.55, r * 0.65);
      ctx.closePath();
      ctx.stroke();

      // Bright white center pivot dot
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(0, 0, cell * 0.1, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    }, 1000 / HZ_HUD);

    return () => clearInterval(id);
  }, [phase, visible]);

  if (phase !== 'playing') return null;

  return (
    <div className={`minimap${visible ? '' : ' minimap-hidden'}`}>
      <div className="minimap-level-badge">{levelText}</div>
      <canvas ref={canvasRef} style={{ width: PX, height: PX }} />
      <div className="minimap-footer">
        <div className="minimap-legend">
          <span className="legend-item legend-l0" title="Lower Maintenance">L0</span>
          <span className="legend-item legend-l1" title="Main Office">L1</span>
          <span className="legend-item legend-l2" title="Upper Mezzanine">L2</span>
          <span className="legend-item legend-stairs" title="Staircase">▲</span>
        </div>
        <span className="minimap-hint">M</span>
      </div>
    </div>
  );
}
