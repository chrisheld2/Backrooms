import React, { useCallback, useEffect, useRef } from 'react';
import { Canvas } from '@react-three/fiber';
import * as THREE from 'three';
import { DPR_MIN, DPR_MAX, FOG_COLOR } from './game/config.js';
import { useGame } from './game/store.js';
import { initAudio, resumeAudio, suspendAudio, disposeAudio, setSfxMuted, setSfxVolume, setMusicMuted, setMusicVolume, playMusic, pauseMusic } from './game/audio.js';
import { disposeTextures } from './game/textures.js';
import World from './components/World.jsx';
import VisualEffects from './components/VisualEffects.jsx';
import Hud from './ui/Hud.jsx';
import Overlays from './ui/Overlays.jsx';

/**
 * App shell: renderer configuration, pointer lock, lifecycle.
 *
 * The <Canvas> itself never re-renders on gameplay events — the only prop that
 * changes is `key={runId}` on <World>, which is the intended full teardown when
 * a new run starts.
 */
export default function App() {
  const phase = useGame((s) => s.phase);
  const seed = useGame((s) => s.seed);
  const runId = useGame((s) => s.runId);
  const pause = useGame((s) => s.pause);
  const sfxMuted = useGame((s) => s.sfxMuted);
  const sfxVolume = useGame((s) => s.sfxVolume);
  const musicMuted = useGame((s) => s.musicMuted);
  const musicVolume = useGame((s) => s.musicVolume);
  const visualEffects = useGame((s) => s.visualEffects);

  const canvasRef = useRef(null);
  const playing = phase === 'playing';

  const requestLock = useCallback(() => {
    resumeAudio();
    const el = canvasRef.current;
    if (!el) return;
    const p = el.requestPointerLock?.();
    // Chrome 113+ returns a promise; a rejection here is benign (the user
    // pressed ESC too recently), so it must not surface as an unhandled reject.
    if (p && typeof p.catch === 'function') p.catch(() => {});
  }, []);

  // Release the mouse the moment the run ends.
  useEffect(() => {
    if (phase === 'dead' || phase === 'won' || phase === 'menu') {
      if (document.pointerLockElement) document.exitPointerLock();
    }
  }, [phase]);

  // Pausing must stop the entire procedural soundscape, including ambience
  // and any scheduled one-shots. The resume/start actions restore the context.
  useEffect(() => {
    if (phase === 'paused') suspendAudio();
  }, [phase]);

  // Background music: starts (and resumes) whenever a run is actively
  // playing, pauses whenever the pause menu is open.
  useEffect(() => {
    if (phase === 'playing') playMusic();
    else if (phase === 'paused') pauseMusic();
  }, [phase]);

  // Backgrounded tabs get paused: rAF is already throttled there, but audio and
  // the simulation should stop cleanly rather than fast-forward on return.
  useEffect(() => {
    function onVisibility() {
      if (document.hidden) { pause(); suspendAudio(); }
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [pause]);

  useEffect(() => {
    initAudio();
    return () => {
      // Process-level teardown: module-cached GPU textures and the audio graph
      // outlive individual runs, so this is where they die.
      disposeTextures();
      disposeAudio();
    };
  }, []);

  useEffect(() => {
    setSfxMuted(sfxMuted);
  }, [sfxMuted]);

  useEffect(() => {
    setSfxVolume(sfxVolume);
  }, [sfxVolume]);

  useEffect(() => {
    setMusicMuted(musicMuted);
  }, [musicMuted]);

  useEffect(() => {
    setMusicVolume(musicVolume);
  }, [musicVolume]);

  return (
    <div className="app">
      <Canvas
        ref={canvasRef}
        dpr={[DPR_MIN, DPR_MAX]}
        frameloop={playing ? 'always' : 'never'}
        shadows={false}
        gl={{
          antialias: false, // fog + a matte palette hide aliasing; MSAA is not worth the bandwidth
          powerPreference: 'high-performance',
          stencil: false,
          depth: true,
          alpha: false,
        }}
        camera={{ fov: 74, near: 0.05, far: 55 }}
        onCreated={({ gl, scene }) => {
          gl.setClearColor(FOG_COLOR, 1);
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = 1.15;
          scene.matrixWorldAutoUpdate = true;
        }}
        onPointerDown={() => { if (!playing) return; requestLock(); }}
      >
        <World key={runId} seed={seed} active={playing} />
        <VisualEffects settings={visualEffects} />
      </Canvas>

      <Hud />
      <Overlays onRequestLock={requestLock} />
    </div>
  );
}
