import React, { useEffect, useRef, useState } from 'react';
import { CELL, GRID_W, GRID_H, HALF_W, HALF_H, HZ_HUD } from '../game/config.js';
import { player, entity, world } from '../game/runtime.js';
import { useGame } from '../game/store.js';

// Cells of the grid visible across the minimap's diameter, centered on the
// player. Odd so the player cell sits dead center.
const RADIUS = 13;
const SPAN = RADIUS * 2 + 1;
const PX = 200; // CSS pixel size of the canvas, square

/**
 * Translucent top-down minimap, toggled with M.
 *
 * Drawn on a plain 2D canvas on its own throttled timer (HZ_HUD, same as the
 * rest of the HUD) rather than every frame — a human can't perceive a map
 * redrawing faster than that, and canvas fill/stroke calls are not free.
 * Visibility is the only piece of this that touches React state: it changes
 * a few times per run at most, so a re-render on toggle is free.
 */
export default function Minimap() {
  const phase = useGame((s) => s.phase);
  const [visible, setVisible] = useState(true);
  const canvasRef = useRef(null);
  const dprRef = useRef(Math.min(window.devicePixelRatio || 1, 2));

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

    const id = setInterval(() => {
      const grid = world.grid;
      if (!grid) return;

      // Keep the player at the exact canvas centre. Using their cell here made
      // the whole map jump at cell boundaries and snapped moving markers to
      // the wrong places within a cell.
      const playerGX = player.x / CELL + HALF_W;
      const playerGY = player.z / CELL + HALF_H;
      // Start with the cell that intersects the map's top/left edge, so the
      // 27-cell draw window still fills the canvas at every sub-cell position.
      const originX = Math.floor(playerGX - RADIUS - 0.5);
      const originY = Math.floor(playerGY - RADIUS - 0.5);
      const toMapX = (worldX) => canvas.width * 0.5 + ((worldX / CELL + HALF_W) - playerGX) * cell;
      const toMapY = (worldZ) => canvas.height * 0.5 + ((worldZ / CELL + HALF_H) - playerGY) * cell;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Walls / floor
      for (let gy = 0; gy < SPAN; gy++) {
        const cy = originY + gy;
        if (cy < 0 || cy >= GRID_H) continue;
        for (let gx = 0; gx < SPAN; gx++) {
          const cx = originX + gx;
          if (cx < 0 || cx >= GRID_W) continue;
          const open = grid[cy * GRID_W + cx] === 0;
          ctx.fillStyle = open ? 'rgba(216,207,154,0.16)' : 'rgba(10,9,6,0.55)';
          const x = canvas.width * 0.5 + (cx + 0.5 - playerGX) * cell;
          const y = canvas.height * 0.5 + (cy + 0.5 - playerGY) * cell;
          ctx.fillRect(x - cell * 0.5, y - cell * 0.5, cell + 0.5, cell + 0.5);
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

      // Entity, only while actively hunting and known to be near — the map
      // must not turn into a wallhack.
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

      // Player, always centered, with a facing wedge.
      const cx = canvas.width * 0.5;
      const cyp = canvas.height * 0.5;
      const yaw = player.yaw;
      ctx.save();
      ctx.translate(cx, cyp);
      // Canvas Y increases south while positive Three.js yaw turns the player
      // west; negate it so the wedge matches the first-person heading.
      ctx.rotate(-yaw);
      ctx.fillStyle = '#ffe9a8';
      ctx.beginPath();
      ctx.moveTo(0, -cell * 0.6);
      ctx.lineTo(cell * 0.4, cell * 0.5);
      ctx.lineTo(-cell * 0.4, cell * 0.5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }, 1000 / HZ_HUD);

    return () => clearInterval(id);
  }, [phase, visible]);

  if (phase !== 'playing') return null;

  return (
    <div className={`minimap${visible ? '' : ' minimap-hidden'}`}>
      <canvas ref={canvasRef} style={{ width: PX, height: PX }} />
      <span className="minimap-hint">M</span>
    </div>
  );
}
