import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { TerminalDisplayMode } from "./canvasStore";

interface UiSettingsState {
  // Default displayMode assigned to newly created top-level (non-pipeline) terminal nodes,
  // keyed by projectId. Falls back to "live" for projects with no stored preference.
  projectDefaultTerminalDisplayMode: Record<string, TerminalDisplayMode>;

  getProjectDefaultTerminalDisplayMode: (projectId: string | null) => TerminalDisplayMode;
  setProjectDefaultTerminalDisplayMode: (projectId: string, mode: TerminalDisplayMode) => void;
}

export const useUiSettingsStore = create<UiSettingsState>()(
  persist(
    (set, get) => ({
      projectDefaultTerminalDisplayMode: {},

      getProjectDefaultTerminalDisplayMode: (projectId) => {
        if (!projectId) return "live";
        return get().projectDefaultTerminalDisplayMode[projectId] ?? "live";
      },

      setProjectDefaultTerminalDisplayMode: (projectId, mode) =>
        set((state) => ({
          projectDefaultTerminalDisplayMode: { ...state.projectDefaultTerminalDisplayMode, [projectId]: mode },
        })),
    }),
    { name: "central-ui-settings" }
  )
);
