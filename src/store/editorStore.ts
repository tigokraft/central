import { create } from "zustand";
import { readFile, writeFile } from "../lib/workspaceFs";

export interface EditorTab {
  path: string;
  content: string;
  // Last content known to match disk (either just loaded, just saved, or just reloaded).
  // Comparing against this — not against `content` — is what lets a save clear `dirty`.
  originalContent: string;
  dirty: boolean;
  loading: boolean;
  error: string | null;
  // Bumped whenever `content` is replaced by something other than the user typing (initial
  // load, silent reload, "keep mine"-then-reload). CodeMirrorHost watches this to know when it
  // must rebuild the tab's EditorState instead of reusing its cached one.
  reloadVersion: number;
  // True once the watcher reports a change to a *dirty* file on disk — the local edit and the
  // on-disk version have diverged, so the UI shows a banner instead of silently picking a side.
  externalChangePending: boolean;
  diffMode: boolean;
}

interface EditorStoreState {
  projectId: string | null;
  tabs: Record<string, EditorTab>;
  order: string[];
  activePath: string | null;

  openFile: (projectId: string, path: string) => Promise<void>;
  closeFile: (path: string) => void;
  setActivePath: (path: string) => void;
  updateContent: (path: string, content: string) => void;
  saveFile: (path: string) => Promise<void>;
  reloadFile: (path: string) => Promise<void>;
  keepMine: (path: string) => void;
  toggleDiff: (path: string) => void;
  handleExternalChange: () => void;
  resetForProject: (projectId: string | null) => void;
}

function blankTab(path: string): EditorTab {
  return {
    path,
    content: "",
    originalContent: "",
    dirty: false,
    loading: true,
    error: null,
    reloadVersion: 0,
    externalChangePending: false,
    diffMode: false,
  };
}

export const useEditorStore = create<EditorStoreState>((set, get) => ({
  projectId: null,
  tabs: {},
  order: [],
  activePath: null,

  resetForProject: (projectId) => set({ projectId, tabs: {}, order: [], activePath: null }),

  openFile: async (projectId, path) => {
    if (get().projectId !== projectId) {
      get().resetForProject(projectId);
    }

    const existing = get().tabs[path];
    if (existing) {
      set({ activePath: path });
      return;
    }

    set((state) => ({
      tabs: { ...state.tabs, [path]: blankTab(path) },
      order: state.order.includes(path) ? state.order : [...state.order, path],
      activePath: path,
    }));

    try {
      const content = await readFile(projectId, path);
      // The project (or the tab itself, via a fast close) may have moved on while this
      // read was in flight; only apply the result if it's still relevant.
      if (get().projectId !== projectId || !get().tabs[path]) return;
      set((state) => ({
        tabs: {
          ...state.tabs,
          [path]: { ...state.tabs[path], content, originalContent: content, loading: false },
        },
      }));
    } catch (err) {
      if (get().projectId !== projectId || !get().tabs[path]) return;
      set((state) => ({
        tabs: {
          ...state.tabs,
          [path]: { ...state.tabs[path], loading: false, error: String(err) },
        },
      }));
    }
  },

  closeFile: (path) => {
    set((state) => {
      const tabs = { ...state.tabs };
      delete tabs[path];
      const order = state.order.filter((p) => p !== path);
      const activePath =
        state.activePath === path ? order[order.length - 1] ?? null : state.activePath;
      return { tabs, order, activePath };
    });
  },

  setActivePath: (path) => set({ activePath: path }),

  updateContent: (path, content) => {
    set((state) => {
      const tab = state.tabs[path];
      if (!tab) return state;
      return {
        tabs: { ...state.tabs, [path]: { ...tab, content, dirty: content !== tab.originalContent } },
      };
    });
  },

  saveFile: async (path) => {
    const { projectId } = get();
    const tab = get().tabs[path];
    if (!projectId || !tab) return;
    await writeFile(projectId, path, tab.content);
    set((state) => {
      const current = state.tabs[path];
      if (!current) return state;
      return {
        tabs: {
          ...state.tabs,
          [path]: { ...current, originalContent: current.content, dirty: false },
        },
      };
    });
  },

  reloadFile: async (path) => {
    const { projectId } = get();
    if (!projectId || !get().tabs[path]) return;
    try {
      const content = await readFile(projectId, path);
      set((state) => {
        const current = state.tabs[path];
        if (!current) return state;
        return {
          tabs: {
            ...state.tabs,
            [path]: {
              ...current,
              content,
              originalContent: content,
              dirty: false,
              externalChangePending: false,
              reloadVersion: current.reloadVersion + 1,
            },
          },
        };
      });
    } catch (err) {
      console.error(`Failed to reload "${path}":`, err);
    }
  },

  keepMine: (path) => {
    set((state) => {
      const tab = state.tabs[path];
      if (!tab) return state;
      return { tabs: { ...state.tabs, [path]: { ...tab, externalChangePending: false } } };
    });
  },

  toggleDiff: (path) => {
    set((state) => {
      const tab = state.tabs[path];
      if (!tab) return state;
      return { tabs: { ...state.tabs, [path]: { ...tab, diffMode: !tab.diffMode } } };
    });
  },

  // Called on every debounced "workspace-fs-changed" watcher event. The event only reports
  // which paths changed, not the new content, so the simplest correct response — mirroring
  // FilesPanel's own refresh-everything-visited approach — is to re-read every currently open
  // tab and reconcile rather than trying to map watcher paths onto tab paths.
  handleExternalChange: () => {
    const { projectId, tabs } = get();
    if (!projectId) return;
    Object.values(tabs).forEach((tab) => {
      if (tab.loading) return;
      void readFile(projectId, tab.path)
        .then((diskContent) => {
          const current = get().tabs[tab.path];
          if (!current) return;
          if (diskContent === current.content) return;
          if (current.dirty) {
            set((state) => ({
              tabs: {
                ...state.tabs,
                [tab.path]: { ...state.tabs[tab.path], externalChangePending: true },
              },
            }));
          } else {
            set((state) => ({
              tabs: {
                ...state.tabs,
                [tab.path]: {
                  ...state.tabs[tab.path],
                  content: diskContent,
                  originalContent: diskContent,
                  reloadVersion: state.tabs[tab.path].reloadVersion + 1,
                },
              },
            }));
          }
        })
        .catch((err) => console.error(`Failed to check "${tab.path}" for external changes:`, err));
    });
  },
}));
