import { create } from "zustand";
import { startWorkspaceWatcher, stopWorkspaceWatcher } from "../lib/workspaceFs";

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
  // The single point every project-open flow (HomeView's open/create, CommandPalette's
  // switch-to-project) funnels through, so the workspace file watcher always tracks whichever
  // project is actually active without each call site needing to remember to start it.
  openProject: (projectId) => {
    set({ view: "canvas", activeProjectId: projectId });
    void startWorkspaceWatcher(projectId).catch((err) =>
      console.error("Failed to start workspace watcher:", err)
    );
  },
  goHome: () => {
    set({ view: "home", activeProjectId: null });
    void stopWorkspaceWatcher().catch((err) =>
      console.error("Failed to stop workspace watcher:", err)
    );
  },
}));
