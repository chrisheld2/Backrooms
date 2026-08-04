import { create } from 'zustand';

const SETTINGS_KEY = 'backrooms-settings';

export const DEFAULT_VISUAL_EFFECTS = {
  bloom: 0.25,
  vignette: 0.35,
  grain: 0.08,
  scanlines: 0,
  chromaticAberration: 0,
  pixelation: 0,
  blur: 0,
  saturation: 0,
  contrast: 0,
  grayscale: 0,
  sepia: 0,
  invert: 0,
  analogVCR: 0,
  vcrJitter: 0.5,
  vcrTear: 0.3,
  vcrDynamic: false,
};

function readSettings() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(SETTINGS_KEY));
    return {
      muted: Boolean(saved?.muted),
      visualEffects: { ...DEFAULT_VISUAL_EFFECTS, ...saved?.visualEffects },
    };
  } catch {
    return { muted: false, visualEffects: DEFAULT_VISUAL_EFFECTS };
  }
}

function saveSettings(settings) {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage can be unavailable in private/restricted browser contexts.
  }
}

const initialSettings = typeof window === 'undefined'
  ? { muted: false, visualEffects: DEFAULT_VISUAL_EFFECTS }
  : readSettings();

/**
 * LOW-FREQUENCY state only. Every setter here triggers a React render pass, so
 * the rule is: if it can change more than a couple of times per second, it does
 * not belong in this store — put it in runtime.js and sample it on a timer.
 *
 * Legal members: game phase, run seed, and end-of-run summary values.
 */
export const useGame = create((set) => ({
  phase: 'menu', // 'menu' | 'playing' | 'paused' | 'dead' | 'won'
  seed: (Math.random() * 0xffffffff) >>> 0,
  runId: 0,
  deathCause: '',
  finalTime: 0,
  ...initialSettings,

  start: () => set((s) => ({
    phase: 'playing',
    seed: (Math.random() * 0xffffffff) >>> 0,
    runId: s.runId + 1,
    deathCause: '',
  })),
  resume: () => set({ phase: 'playing' }),
  setMuted: (muted) => {
    saveSettings({ muted, visualEffects: useGame.getState().visualEffects });
    set({ muted });
  },
  setVisualEffect: (effect, value) => set((state) => {
    const visualEffects = { ...state.visualEffects, [effect]: value };
    saveSettings({ muted: state.muted, visualEffects });
    return { visualEffects };
  }),
  resetVisualEffects: () => set((state) => {
    const visualEffects = { ...DEFAULT_VISUAL_EFFECTS };
    saveSettings({ muted: state.muted, visualEffects });
    return { visualEffects };
  }),
  pause: () => set((s) => (s.phase === 'playing' ? { phase: 'paused' } : {})),
  die: (cause, time) => set((s) => (
    s.phase === 'playing' ? { phase: 'dead', deathCause: cause, finalTime: time } : {}
  )),
  win: (time) => set((s) => (s.phase === 'playing' ? { phase: 'won', finalTime: time } : {})),
  toMenu: () => set({ phase: 'menu' }),
}));
