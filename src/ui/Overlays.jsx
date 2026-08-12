import React, { useState } from 'react';
import { useGame } from '../game/store.js';
import { world } from '../game/runtime.js';

/** Menu / pause / death / victory screens. Rendered only when not playing. */
export default function Overlays({ onRequestLock }) {
  const phase = useGame((s) => s.phase);
  const deathCause = useGame((s) => s.deathCause);
  const finalTime = useGame((s) => s.finalTime);
  const start = useGame((s) => s.start);
  const resume = useGame((s) => s.resume);
  const sfxMuted = useGame((s) => s.sfxMuted);
  const setSfxMuted = useGame((s) => s.setSfxMuted);
  const sfxVolume = useGame((s) => s.sfxVolume);
  const setSfxVolume = useGame((s) => s.setSfxVolume);
  const musicMuted = useGame((s) => s.musicMuted);
  const setMusicMuted = useGame((s) => s.setMusicMuted);
  const musicVolume = useGame((s) => s.musicVolume);
  const setMusicVolume = useGame((s) => s.setMusicVolume);
  const visualEffects = useGame((s) => s.visualEffects);
  const setVisualEffect = useGame((s) => s.setVisualEffect);
  const resetVisualEffects = useGame((s) => s.resetVisualEffects);
  const [pauseTab, setPauseTab] = useState('game');

  if (phase === 'playing') return null;

  const time = formatTime(finalTime);

  return (
    <div className={`overlay overlay-${phase}`}>
      <div className="overlay-inner">
        {/* Office Paper Accents: Tape, Coffee Stain, Ink Smudges */}
        <div className="paper-tape-left" />
        <div className="paper-tape-right" />
        <div className="paper-coffee-stain" />
        <div className="paper-smudge-1" />
        <div className="paper-smudge-2" />
        <div className="paper-smudge-3" />

        {phase === 'menu' && (
          <>
            <div className="paper-stamp">ARCHIVE LOG #04</div>
            <div className="margin-note">ALMOND WATER = LIFE</div>
            <h1>THE BACKROOMS</h1>
            <p className="sub">LEVEL 0 &mdash; &ldquo;THE LOBBY&rdquo;</p>
            <p className="body">
              You noclipped out of reality. 600 million square miles of damp
              carpet, buzzing fluorescent lights and the endless smell of old
              wallpaper. Find six crates of almond water, then find the exit.
            </p>
            <p className="body dim">
              You are not alone down here. It hunts by sound &mdash; sprinting is loud.
            </p>
            <Controls />
            <button className="btn" onClick={() => { start(); onRequestLock(); }}>
              ENTER LEVEL 0
            </button>
          </>
        )}

        {phase === 'paused' && (
          <>
            <div className="paper-stamp">SUSPENDED</div>
            <div className="margin-note">DON'T LOOK BACK</div>
            <h1>PAUSED</h1>
            <div className="pause-tabs" role="tablist">
              <button className={pauseTab === 'game' ? 'active' : ''} onClick={() => setPauseTab('game')} role="tab">GAME</button>
              <button className={pauseTab === 'audio' ? 'active' : ''} onClick={() => setPauseTab('audio')} role="tab">AUDIO</button>
              <button className={pauseTab === 'effects' ? 'active' : ''} onClick={() => setPauseTab('effects')} role="tab">VISUAL EFFECTS</button>
            </div>
            <div className="pause-tab-body">
              {pauseTab === 'game' && <Controls />}
              {pauseTab === 'audio' && <AudioPanel
                sfxMuted={sfxMuted} setSfxMuted={setSfxMuted} sfxVolume={sfxVolume} setSfxVolume={setSfxVolume}
                musicMuted={musicMuted} setMusicMuted={setMusicMuted} musicVolume={musicVolume} setMusicVolume={setMusicVolume}
              />}
              {pauseTab === 'effects' && <VisualEffectsPanel settings={visualEffects} onChange={setVisualEffect} onReset={resetVisualEffects} />}
            </div>
            <div className="pause-actions">
              <button className="btn" onClick={() => { resume(); onRequestLock(); }}>RESUME</button>
              <button className="btn ghost" onClick={() => { start(); onRequestLock(); }}>RESTART RUN</button>
            </div>
          </>
        )}

        {phase === 'dead' && (
          <>
            <div className="paper-stamp bad-stamp">TERMINATED</div>
            <div className="margin-note">IT HEARS EVERYTHING</div>
            <h1 className="bad">YOU DID NOT MAKE IT OUT</h1>
            <p className="sub">{deathCause}</p>
            <p className="body">
              Survived {time} &middot; {world.collected} / {world.total} crates recovered
            </p>
            <button className="btn" onClick={() => { start(); onRequestLock(); }}>
              NOCLIP AGAIN
            </button>
          </>
        )}

        {phase === 'won' && (
          <>
            <div className="paper-stamp good-stamp">SURVIVED</div>
            <div className="margin-note">LEVEL 1 AHEAD?</div>
            <h1 className="good">YOU FOUND A WAY OUT</h1>
            <p className="sub">Level 0 cleared in {time}</p>
            <p className="body dim">
              The door opens onto more yellow rooms. It always does.
            </p>
            <button className="btn" onClick={() => { start(); onRequestLock(); }}>
              GO DEEPER
            </button>
          </>
        )}
      </div>
    </div>
  );
}

const EFFECTS = [
  ['ssao', 'SSAO'],
  ['bloom', 'Bloom'], ['vignette', 'Vignette'], ['grain', 'Film grain'], ['scanlines', 'Scanlines'],
  ['chromaticAberration', 'Chromatic aberration'], ['pixelation', 'Pixelation'], ['blur', 'Blur'],
  ['saturation', 'Saturation'], ['contrast', 'Contrast'], ['grayscale', 'Grayscale'], ['sepia', 'Sepia'], ['invert', 'Invert'],
];
const VCR_EFFECTS = [
  ['analogVCR', 'Analog VCR'], ['vcrJitter', 'Horizontal jitter'], ['vcrTear', 'Tear frequency'],
];

function AudioPanel({ sfxMuted, setSfxMuted, sfxVolume, setSfxVolume, musicMuted, setMusicMuted, musicVolume, setMusicVolume }) {
  return <div className="audio-settings" role="tabpanel">
    <div className="audio-channel">
      <label className="effect-control volume-control">
        <span>Sound volume</span>
        <output>{Math.round(sfxVolume * 100)}%</output>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={sfxVolume}
          onChange={(event) => setSfxVolume(Number(event.target.value))}
          aria-label="Sound effects volume"
        />
      </label>
      <button className={`btn ghost mute-toggle${sfxMuted ? ' is-muted' : ''}`} onClick={() => setSfxMuted(!sfxMuted)} aria-pressed={sfxMuted}>SOUND: {sfxMuted ? 'MUTED' : 'ON'}</button>
    </div>
    <div className="audio-channel">
      <label className="effect-control volume-control">
        <span>Music volume</span>
        <output>{Math.round(musicVolume * 100)}%</output>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={musicVolume}
          onChange={(event) => setMusicVolume(Number(event.target.value))}
          aria-label="Music volume"
        />
      </label>
      <button className={`btn ghost mute-toggle${musicMuted ? ' is-muted' : ''}`} onClick={() => setMusicMuted(!musicMuted)} aria-pressed={musicMuted}>MUSIC: {musicMuted ? 'MUTED' : 'ON'}</button>
    </div>
  </div>;
}

function VisualEffectsPanel({ settings, onChange, onReset }) {
  return <div className="effects-panel" role="tabpanel">
    <p className="effects-note">Changes apply immediately and are saved automatically.</p>
    <div className="effects-grid">{EFFECTS.map(([key, label]) => <label key={key} className="effect-control">
      <span>{label}</span><output>{Math.round(settings[key] * 100)}%</output>
      <input type="range" min="0" max="1" step="0.01" value={settings[key]} onChange={(event) => onChange(key, Number(event.target.value))} />
    </label>)}</div>
    <h4 className="effects-section-title">Lighting</h4>
    <label className="effect-control">
      <span>Volumetric Fog</span>
      <select value={settings.volumetricFog ?? 0} onChange={(event) => onChange('volumetricFog', Number(event.target.value))}>
        <option value="0">Off</option>
        <option value="1">Low</option>
        <option value="2">Medium</option>
        <option value="3">High</option>
      </select>
    </label>
    <label className="effect-control effect-toggle">
      <span>Real-Time Shadows</span>
      <input type="checkbox" checked={settings.realTimeShadows} onChange={(event) => onChange('realTimeShadows', event.target.checked)} />
    </label>
    <h4 className="effects-section-title">Analog VCR</h4>
    <label className="effect-control effect-toggle">
      <span>Dynamic variation</span>
      <input type="checkbox" checked={settings.vcrDynamic} onChange={(event) => onChange('vcrDynamic', event.target.checked)} />
    </label>
    <div className="effects-grid">{VCR_EFFECTS.map(([key, label]) => <label key={key} className="effect-control">
      <span>{label}</span><output>{Math.round(settings[key] * 100)}%</output>
      <input type="range" min="0" max="1" step="0.01" value={settings[key]} onChange={(event) => onChange(key, Number(event.target.value))} />
    </label>)}</div>
    <button className="btn ghost effects-reset" onClick={onReset}>RESET EFFECTS</button>
  </div>;
}

function Controls() {
  return (
    <ul className="controls">
      <li><b>W A S D</b> move</li>
      <li><b>MOUSE</b> look</li>
      <li><b>SHIFT</b> sprint (loud, limited)</li>
      <li><b>C</b> crouch (slow, quiet)</li>
      <li><b>F</b> flashlight</li>
      <li><b>ESC</b> pause</li>
    </ul>
  );
}

function formatTime(t) {
  const m = (t / 60) | 0;
  const s = (t % 60) | 0;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}
