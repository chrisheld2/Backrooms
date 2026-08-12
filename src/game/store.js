import { create } from 'zustand';

const SETTINGS_KEY = 'backrooms-settings';

export const DEFAULT_VISUAL_EFFECTS = {
  ssao: 0,
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
  realTimeShadows: false,
};

function clampVolume(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.max(0, Math.min(1, n));
}

const DEFAULT_SETTINGS = {
  sfxMuted: false,
  sfxVolume: 1,
  musicMuted: false,
  musicVolume: 1,
  visualEffects: DEFAULT_VISUAL_EFFECTS,
};

function readSettings() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(SETTINGS_KEY));
    // Back-compat: older saves had a single `muted`/`volume` pair that
    // controlled sound and music together. Seed both buses from it.
    const legacyMuted = Boolean(saved?.muted);
    const legacyVolume = clampVolume(saved?.volume ?? 1);
    return {
      sfxMuted: saved?.sfxMuted ?? legacyMuted,
      sfxVolume: clampVolume(saved?.sfxVolume ?? legacyVolume),
      musicMuted: saved?.musicMuted ?? legacyMuted,
      musicVolume: clampVolume(saved?.musicVolume ?? legacyVolume),
      visualEffects: { ...DEFAULT_VISUAL_EFFECTS, ...saved?.visualEffects },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(settings) {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage can be unavailable in private/restricted browser contexts.
  }
}

const initialSettings = typeof window === 'undefined' ? DEFAULT_SETTINGS : readSettings();

function persistSettings(partial) {
  const state = useGame.getState();
  saveSettings({
    sfxMuted: partial.sfxMuted ?? state.sfxMuted,
    sfxVolume: partial.sfxVolume ?? state.sfxVolume,
    musicMuted: partial.musicMuted ?? state.musicMuted,
    musicVolume: partial.musicVolume ?? state.musicVolume,
    visualEffects: partial.visualEffects ?? state.visualEffects,
  });
}

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
  setSfxMuted: (sfxMuted) => {
    persistSettings({ sfxMuted });
    set({ sfxMuted });
  },
  setSfxVolume: (volume) => {
    const sfxVolume = clampVolume(volume);
    persistSettings({ sfxVolume });
    set({ sfxVolume });
  },
  setMusicMuted: (musicMuted) => {
    persistSettings({ musicMuted });
    set({ musicMuted });
  },
  setMusicVolume: (volume) => {
    const musicVolume = clampVolume(volume);
    persistSettings({ musicVolume });
    set({ musicVolume });
  },
  setVisualEffect: (effect, value) => set((state) => {
    const visualEffects = { ...state.visualEffects, [effect]: value };
    persistSettings({ visualEffects });
    return { visualEffects };
  }),
  resetVisualEffects: () => set((state) => {
    const visualEffects = { ...DEFAULT_VISUAL_EFFECTS };
    persistSettings({ visualEffects });
    return { visualEffects };
  }),
  pause: () => set((s) => (s.phase === 'playing' ? { phase: 'paused' } : {})),
  die: (cause, time) => set((s) => (
    s.phase === 'playing' ? { phase: 'dead', deathCause: cause, finalTime: time } : {}
  )),
  win: (time) => set((s) => (s.phase === 'playing' ? { phase: 'won', finalTime: time } : {})),
  toMenu: () => set({ phase: 'menu' }),
}));
