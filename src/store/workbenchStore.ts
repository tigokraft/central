import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { type WorkbenchBinding, type WorkbenchSessionMeta } from "../lib/workbench";

export interface WorkbenchSession extends WorkbenchSessionMeta {
  // Resolved working directory for this session's terminal — the main workspace root for a
  // "main" binding, or the session's own worktree path otherwise. Transient: re-resolved via
  // bind_workbench_session on every load rather than persisted, since the persisted manifest
  // only stores binding/agent/label (see project.rs::WorkbenchSessionMeta).
  cwd: string | null;
}

interface WorkbenchState {
  projectId: string | null;
  sessions: WorkbenchSession[];
  focusedSessionId: string | null;
  loading: boolean;
  loadForProject: (projectId: string) => Promise<void>;
  createSession: (opts: { label: string; agentId: string | null; binding: WorkbenchBinding }) => Promise<void>;
  updateBinding: (sessionId: string, binding: WorkbenchBinding) => Promise<void>;
  updateSession: (sessionId: string, patch: Partial<Pick<WorkbenchSessionMeta, "label" | "agentId">>) => void;
  removeSession: (sessionId: string) => Promise<void>;
  setFocusedSessionId: (sessionId: string | null) => void;
}

let sessionSeq = 0;
function nextSessionId(): string {
  sessionSeq += 1;
  return `wb-${Date.now()}-${sessionSeq}`;
}

function toMeta(session: WorkbenchSession): WorkbenchSessionMeta {
  return { id: session.id, label: session.label, agentId: session.agentId, binding: session.binding };
}

async function persist(projectId: string, sessions: WorkbenchSession[]) {
  try {
    await invoke("save_workbench_sessions", { projectId, sessions: sessions.map(toMeta) });
  } catch (err) {
    console.error("Failed to persist workbench sessions:", err);
  }
}

export const useWorkbenchStore = create<WorkbenchState>((set, get) => ({
  projectId: null,
  sessions: [],
  focusedSessionId: null,
  loading: false,

  loadForProject: async (projectId) => {
    set({ projectId, sessions: [], focusedSessionId: null, loading: true });
    let metas: WorkbenchSessionMeta[] = [];
    try {
      metas = await invoke<WorkbenchSessionMeta[]>("list_workbench_sessions", { projectId });
    } catch (err) {
      console.error("Failed to list workbench sessions:", err);
    }

    const sessions: WorkbenchSession[] = [];
    for (const meta of metas) {
      try {
        const cwd = await invoke<string>("bind_workbench_session", {
          projectId,
          sessionId: meta.id,
          binding: meta.binding,
        });
        sessions.push({ ...meta, cwd });
      } catch (err) {
        console.error(`Failed to bind workbench session "${meta.id}":`, err);
        sessions.push({ ...meta, cwd: null });
      }
    }

    // The project may have changed again while these binds were in flight; don't clobber it.
    if (get().projectId === projectId) set({ sessions, loading: false });
  },

  createSession: async ({ label, agentId, binding }) => {
    const { projectId } = get();
    if (!projectId) return;
    const id = nextSessionId();
    const cwd = await invoke<string>("bind_workbench_session", { projectId, sessionId: id, binding });
    const session: WorkbenchSession = { id, label, agentId, binding, cwd };
    const sessions = [...get().sessions, session];
    set({ sessions });
    await persist(projectId, sessions);
  },

  updateBinding: async (sessionId, binding) => {
    const { projectId, sessions } = get();
    if (!projectId || !sessions.some((s) => s.id === sessionId)) return;
    await invoke("discard_workbench_session", { projectId, sessionId });
    const cwd = await invoke<string>("bind_workbench_session", { projectId, sessionId, binding });
    const updated = sessions.map((s) => (s.id === sessionId ? { ...s, binding, cwd } : s));
    set({ sessions: updated });
    await persist(projectId, updated);
  },

  updateSession: (sessionId, patch) => {
    const { projectId, sessions } = get();
    const updated = sessions.map((s) => (s.id === sessionId ? { ...s, ...patch } : s));
    set({ sessions: updated });
    if (projectId) void persist(projectId, updated);
  },

  removeSession: async (sessionId) => {
    const { projectId, sessions, focusedSessionId } = get();
    if (!projectId) return;
    try {
      await invoke("discard_workbench_session", { projectId, sessionId });
    } catch (err) {
      console.error("Failed to discard workbench session binding:", err);
    }
    const updated = sessions.filter((s) => s.id !== sessionId);
    set({ sessions: updated, focusedSessionId: focusedSessionId === sessionId ? null : focusedSessionId });
    await persist(projectId, updated);
  },

  setFocusedSessionId: (sessionId) => set({ focusedSessionId: sessionId }),
}));
