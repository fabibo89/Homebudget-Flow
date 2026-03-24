import { create } from 'zustand';

type Mode = 'light' | 'dark';

const KEY = 'homebudget-theme-mode';

function readMode(): Mode {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch {
    /* ignore */
  }
  return 'dark';
}

type ThemeModeState = {
  mode: Mode;
  setMode: (m: Mode) => void;
  toggle: () => void;
};

export const useThemeModeStore = create<ThemeModeState>((set, get) => ({
  mode: readMode(),
  setMode: (m) => {
    try {
      localStorage.setItem(KEY, m);
    } catch {
      /* ignore */
    }
    set({ mode: m });
  },
  toggle: () => {
    const next = get().mode === 'dark' ? 'light' : 'dark';
    get().setMode(next);
  },
}));
