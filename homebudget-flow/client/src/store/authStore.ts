import { create } from 'zustand';
import { setAuthToken } from '../api/client';

const TOKEN_KEY = 'homebudget-token';

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

const initial = readToken();
if (initial) setAuthToken(initial);

type AuthState = {
  token: string | null;
  setToken: (token: string | null) => void;
  logout: () => void;
};

export const useAuthStore = create<AuthState>((set) => ({
  token: initial,
  setToken: (token) => {
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
    setAuthToken(token);
    set({ token });
  },
  logout: () => {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
    setAuthToken(null);
    set({ token: null });
  },
}));
