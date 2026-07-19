import { create } from "zustand";
import { startWorkspaceWatcher, stopWorkspaceWatcher } from "../lib/workspaceFs";

export type AppView = "home" | "canvas";

// Which per-project surface is showing once a project is open: the pipeline canvas, or the
// team workbench (side-by-side agent terminal sessions). Independent of AppView, which just
// tracks whether a project is open at all.
export type ProjectView = "canvas" | "workbench";

interface AppViewState {
  view: AppView;
  activeProjectId: string | null;
  projectView: ProjectView;
  openProject: (projectId: string) => void;
  goHome: () => void;
  setProjectView: (view: ProjectView) => void;
}

export const useAppViewStore = create<AppViewState>((set) => ({
  view: "home",
  activeProjectId: null,
  projectView: "canvas",
  // The single point every project-open flow (HomeView's open/create, CommandPalette's
  // switch-to-project) funnels through, so the workspace file watcher always tracks whichever
  // project is actually active without each call site needing to remember to start it.
  openProject: (projectId) => {
    set({ view: "canvas", activeProjectId: projectId, projectView: "canvas" });
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
  setProjectView: (projectView) => set({ projectView }),
}));
