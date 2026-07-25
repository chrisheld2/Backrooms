import React, { useEffect, useRef } from 'react';
import { HZ_HUD, STAMINA_MAX, BATTERY_MAX } from '../game/config.js';
import { player, entity, world } from '../game/runtime.js';

/**
 * DOM HUD. Reads the simulation on a timer and writes to DOM nodes through
 * refs — it never re-renders.
 *
 * The naive version of this component holds stamina/battery/timer in useState
 * and updates them from useFrame. That schedules a React reconciliation every
 * frame for text that a human can only read ~8 times a second, and it drags
 * the whole overlay tree through diffing while the render loop is trying to
 * hit frame budget. A setInterval writing `textContent` and `style.width` is
 * strictly cheaper and visually identical.
 */
export default function Hud() {
  const timerRef = useRef(null);
  const foundRef = useRef(null);
  const staminaRef = useRef(null);
  const batteryRef = useRef(null);
  const objectiveRef = useRef(null);
  const vignetteRef = useRef(null);
  const warnRef = useRef(null);

  useEffect(() => {
    const id = setInterval(() => {
      const t = world.elapsed;
      if (timerRef.current) {
        const m = (t / 60) | 0;
        const s = (t % 60) | 0;
        timerRef.current.textContent = `${m}:${s < 10 ? '0' : ''}${s}`;
      }
      if (foundRef.current) {
        foundRef.current.textContent = `${world.collected} / ${world.total}`;
      }
      if (staminaRef.current) {
        staminaRef.current.style.width = `${(player.stamina / STAMINA_MAX) * 100}%`;
        staminaRef.current.style.opacity = player.stamina < STAMINA_MAX ? '1' : '0.35';
      }
      if (batteryRef.current) {
        const pct = (player.battery / BATTERY_MAX) * 100;
        batteryRef.current.style.width = `${pct}%`;
        batteryRef.current.style.background = pct < 15 ? '#c8452e' : '#d8cf9a';
      }
      if (objectiveRef.current) {
        objectiveRef.current.textContent = world.exitOpen
          ? 'FIND THE EXIT'
          : 'FIND THE ALMOND WATER';
      }
      if (vignetteRef.current) {
        vignetteRef.current.style.opacity = String(0.25 + world.dangerLevel * 0.7);
      }
      if (warnRef.current) {
        const show = entity.active && entity.hunting && entity.dist < 18;
        warnRef.current.style.opacity = show ? '1' : '0';
      }
    }, 1000 / HZ_HUD);

    return () => clearInterval(id);
  }, []);

  return (
    <div className="hud">
      <div className="vignette" ref={vignetteRef} />
      <div className="crosshair" />

      <div className="hud-top">
        <span className="hud-objective" ref={objectiveRef}>FIND THE ALMOND WATER</span>
      </div>

      <div className="hud-bottom">
        <div className="hud-block">
          <span className="hud-label">TIME</span>
          <span className="hud-value" ref={timerRef}>0:00</span>
        </div>
        <div className="hud-block">
          <span className="hud-label">ALMOND WATER</span>
          <span className="hud-value" ref={foundRef}>0 / 6</span>
        </div>
        <div className="hud-block hud-bars">
          <span className="hud-label">STAMINA</span>
          <div className="bar"><i ref={staminaRef} className="bar-fill stamina" /></div>
          <span className="hud-label">BATTERY [F]</span>
          <div className="bar"><i ref={batteryRef} className="bar-fill battery" /></div>
        </div>
      </div>

      <div className="hud-warning" ref={warnRef}>IT KNOWS WHERE YOU ARE</div>
    </div>
  );
}
