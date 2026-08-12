/**
 * Fully procedural WebAudio soundscape — zero audio assets to download or decode.
 *
 * Allocation policy: the persistent graph (hum, rumble, master bus) is built
 * once. Transient one-shots (footsteps, stingers) DO allocate a BufferSource
 * per hit, which is unavoidable — WebAudio source nodes are single-use by spec.
 * They are kept small, are freed on `ended`, and fire at most ~2.5/second, so
 * they never approach GC pressure that would show up as a frame spike.
 *
 * The one exception is the background music track (`Hazmat.mp3`), a real
 * asset streamed via an HTMLAudioElement and routed into the graph through a
 * single persistent MediaElementSource into its own gain bus, independently
 * volume/mute-controlled from the procedural SFX bus.
 */

import hazmatUrl from '../media/audio/Hazmat.mp3';

let ctx = null;
let master = null;
let sfxBus = null;
let humGain = null;
let rumbleGain = null;
let heartGain = null;
let noiseBuffer = null;
let started = false;
let humOscA = null;
let humOscB = null;
let rumbleSrc = null;
let heartTimer = 0;
let musicEl = null;
let musicSource = null;
let musicGain = null;
let sfxMuted = false;
let musicMuted = false;
/** User volumes 0..1, applied independently to the SFX bus and the music bus. */
let sfxVolume = 1;
let musicVolume = 1;

const SFX_BASE = 0.9;
const MUSIC_BASE = 0.5;

function sfxTarget() {
  return sfxMuted ? 0 : SFX_BASE * sfxVolume;
}

function musicTarget() {
  return musicMuted ? 0 : MUSIC_BASE * musicVolume;
}

export function initAudio() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();

  master = ctx.createGain();
  master.gain.value = 1;
  master.connect(ctx.destination);

  sfxBus = ctx.createGain();
  sfxBus.gain.value = sfxTarget();
  sfxBus.connect(master);

  // --- Shared white-noise buffer (2s), reused by every noise-based voice.
  noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

  // --- Fluorescent hum: two detuned saws through a narrow bandpass at 120Hz.
  humGain = ctx.createGain();
  humGain.gain.value = 0.0;
  const humFilter = ctx.createBiquadFilter();
  humFilter.type = 'bandpass';
  humFilter.frequency.value = 122;
  humFilter.Q.value = 7;
  humOscA = ctx.createOscillator();
  humOscA.type = 'sawtooth';
  humOscA.frequency.value = 60;
  humOscB = ctx.createOscillator();
  humOscB.type = 'sawtooth';
  humOscB.frequency.value = 120.7;
  humOscA.connect(humFilter);
  humOscB.connect(humFilter);
  humFilter.connect(humGain);
  humGain.connect(sfxBus);
  humOscA.start();
  humOscB.start();

  // --- Sub rumble: looping filtered noise, drives the dread level.
  rumbleGain = ctx.createGain();
  rumbleGain.gain.value = 0.0;
  const rumbleFilter = ctx.createBiquadFilter();
  rumbleFilter.type = 'lowpass';
  rumbleFilter.frequency.value = 90;
  rumbleSrc = ctx.createBufferSource();
  rumbleSrc.buffer = noiseBuffer;
  rumbleSrc.loop = true;
  rumbleSrc.connect(rumbleFilter);
  rumbleFilter.connect(rumbleGain);
  rumbleGain.connect(sfxBus);
  rumbleSrc.start();

  heartGain = ctx.createGain();
  heartGain.gain.value = 0.0;
  heartGain.connect(sfxBus);

  // --- Background music: streamed, looped, routed through its own bus so
  // music volume/mute is independent from the SFX bus.
  musicEl = new Audio(hazmatUrl);
  musicEl.loop = true;
  musicEl.preload = 'auto';
  musicGain = ctx.createGain();
  musicGain.gain.value = musicTarget();
  musicSource = ctx.createMediaElementSource(musicEl);
  musicSource.connect(musicGain);
  musicGain.connect(master);

  started = true;
  return ctx;
}

/** Starts (or resumes) the looping background music track. */
export function playMusic() {
  if (!musicEl) return;
  musicEl.play().catch(() => { /* blocked until a user gesture; retried on next call */ });
}

/** Pauses the background music track without resetting playback position. */
export function pauseMusic() {
  if (!musicEl) return;
  musicEl.pause();
}

export function setSfxMuted(nextMuted) {
  sfxMuted = Boolean(nextMuted);
  if (!sfxBus || !ctx) return;
  sfxBus.gain.setTargetAtTime(sfxTarget(), ctx.currentTime, 0.03);
}

/** Set SFX bus volume 0..1. Mute still forces silence; unmuting restores this level. */
export function setSfxVolume(nextVolume) {
  sfxVolume = Math.max(0, Math.min(1, Number(nextVolume) || 0));
  if (!sfxBus || !ctx) return;
  sfxBus.gain.setTargetAtTime(sfxTarget(), ctx.currentTime, 0.03);
}

export function setMusicMuted(nextMuted) {
  musicMuted = Boolean(nextMuted);
  if (!musicGain || !ctx) return;
  musicGain.gain.setTargetAtTime(musicTarget(), ctx.currentTime, 0.03);
}

/** Set music bus volume 0..1. Mute still forces silence; unmuting restores this level. */
export function setMusicVolume(nextVolume) {
  musicVolume = Math.max(0, Math.min(1, Number(nextVolume) || 0));
  if (!musicGain || !ctx) return;
  musicGain.gain.setTargetAtTime(musicTarget(), ctx.currentTime, 0.03);
}

export function resumeAudio() {
  if (!ctx) initAudio();
  if (ctx && ctx.state === 'suspended') ctx.resume();
}

export function suspendAudio() {
  if (ctx && ctx.state === 'running') ctx.suspend();
}

/** Called on a throttled tick, not per frame. */
export function setAmbience(humLevel, dread) {
  if (!started) return;
  const t = ctx.currentTime;
  humGain.gain.setTargetAtTime(0.055 * humLevel, t, 0.25);
  rumbleGain.gain.setTargetAtTime(0.02 + 0.5 * dread * dread, t, 0.4);
}

export function footstep(sprinting) {
  if (!started || ctx.state !== 'running') return;
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  src.playbackRate.value = 0.8 + Math.random() * 0.4;

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = sprinting ? 1300 : 850;

  const g = ctx.createGain();
  const peak = sprinting ? 0.16 : 0.09;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);

  src.connect(filter);
  filter.connect(g);
  g.connect(sfxBus);
  src.start(t, Math.random() * 1.5, 0.16);
  src.onended = () => { src.disconnect(); filter.disconnect(); g.disconnect(); };
}

/** Heartbeat, pitched and paced by dread. Self-throttled. */
export function heartbeat(dt, dread) {
  if (!started || ctx.state !== 'running' || dread < 0.25) return;
  heartTimer -= dt;
  if (heartTimer > 0) return;
  heartTimer = 1.1 - dread * 0.55;

  const t = ctx.currentTime;
  thump(t, 70 + dread * 20, 0.10 + dread * 0.16);
  thump(t + 0.17, 58 + dread * 16, 0.07 + dread * 0.11);
}

function thump(when, freq, peak) {
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, when);
  osc.frequency.exponentialRampToValueAtTime(freq * 0.5, when + 0.16);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(peak, when + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, when + 0.22);
  osc.connect(g);
  g.connect(sfxBus);
  osc.start(when);
  osc.stop(when + 0.25);
  osc.onended = () => { osc.disconnect(); g.disconnect(); };
}

export function pickupChime() {
  if (!started || ctx.state !== 'running') return;
  const t = ctx.currentTime;
  for (let i = 0; i < 2; i++) {
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = i === 0 ? 660 : 990;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t + i * 0.07);
    g.gain.exponentialRampToValueAtTime(0.08, t + i * 0.07 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.07 + 0.34);
    osc.connect(g);
    g.connect(sfxBus);
    osc.start(t + i * 0.07);
    osc.stop(t + i * 0.07 + 0.36);
    osc.onended = () => { osc.disconnect(); g.disconnect(); };
  }
}

export function jumpscare() {
  if (!started || ctx.state !== 'running') return;
  const t = ctx.currentTime;

  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.setValueAtTime(2600, t);
  filter.frequency.exponentialRampToValueAtTime(180, t + 1.1);
  filter.Q.value = 2.5;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.55, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 1.3);
  src.connect(filter);
  filter.connect(g);
  g.connect(sfxBus);
  src.start(t, 0, 1.4);
  src.onended = () => { src.disconnect(); filter.disconnect(); g.disconnect(); };

  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(220, t);
  osc.frequency.exponentialRampToValueAtTime(34, t + 1.2);
  const og = ctx.createGain();
  og.gain.setValueAtTime(0.3, t);
  og.gain.exponentialRampToValueAtTime(0.0001, t + 1.3);
  osc.connect(og);
  og.connect(sfxBus);
  osc.start(t);
  osc.stop(t + 1.35);
  osc.onended = () => { osc.disconnect(); og.disconnect(); };
}

export function winChord() {
  if (!started || ctx.state !== 'running') return;
  const t = ctx.currentTime;
  const freqs = [261.6, 329.6, 392.0, 523.3];
  for (let i = 0; i < freqs.length; i++) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freqs[i];
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.09, t + 0.12 + i * 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.2);
    osc.connect(g);
    g.connect(sfxBus);
    osc.start(t);
    osc.stop(t + 2.3);
    osc.onended = () => { osc.disconnect(); g.disconnect(); };
  }
}

/** Full teardown of the audio graph. */
export function disposeAudio() {
  if (!ctx) return;
  try {
    humOscA && humOscA.stop();
    humOscB && humOscB.stop();
    rumbleSrc && rumbleSrc.stop();
  } catch { /* already stopped */ }
  if (musicEl) {
    musicEl.pause();
    musicEl.src = '';
    musicSource && musicSource.disconnect();
    musicGain && musicGain.disconnect();
  }
  ctx.close();
  ctx = null; master = null; sfxBus = null; humGain = null; rumbleGain = null;
  heartGain = null; noiseBuffer = null; started = false;
  humOscA = null; humOscB = null; rumbleSrc = null;
  musicEl = null; musicSource = null; musicGain = null;
}
