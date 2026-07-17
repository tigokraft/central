import { create } from "zustand";

export type AppView = "home" | "canvas";

interface AppViewState {
  view: AppView;
  activeProjectId: string | null;
  openProject: (projectId: string) => void;
  goHome: () => void;
}

export const useAppViewStore = create<AppViewState>((set) => ({
  view: "home",
  activeProjectId: null,
  openProject: (projectId) => set({ view: "canvas", activeProjectId: projectId }),
  goHome: () => set({ view: "home", activeProjectId: null }),
}));
