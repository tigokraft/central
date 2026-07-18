import { create } from "zustand";
import { persist } from "zustand/middleware";

export const TERMINAL_FONT_SIZE_MIN = 7;
export const TERMINAL_FONT_SIZE_MAX = 16;
export const DEFAULT_TERMINAL_FONT_SIZE = 10;

export function clampTerminalFontSize(size: number): number {
  return Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, size));
}

interface SettingsState {
  defaultTerminalFontSize: number;
  setDefaultTerminalFontSize: (size: number) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      defaultTerminalFontSize: DEFAULT_TERMINAL_FONT_SIZE,

      setDefaultTerminalFontSize: (size) =>
        set({ defaultTerminalFontSize: clampTerminalFontSize(size) }),
    }),
    { name: "central-settings" }
  )
);
