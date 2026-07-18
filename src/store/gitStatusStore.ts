import { create } from "zustand";
import { getGitStatus, type GitFileStatus } from "../lib/gitStatus";

interface GitStatusState {
  projectId: string | null;
  byPath: Record<string, GitFileStatus>;
  refresh: (projectId: string) => Promise<void>;
  reset: (projectId: string | null) => void;
}

export const useGitStatusStore = create<GitStatusState>((set, get) => ({
  projectId: null,
  byPath: {},

  reset: (projectId) => set({ projectId, byPath: {} }),

  refresh: async (projectId) => {
    if (get().projectId !== projectId) set({ projectId, byPath: {} });
    try {
      const entries = await getGitStatus(projectId);
      if (get().projectId !== projectId) return;
      const byPath: Record<string, GitFileStatus> = {};
      for (const entry of entries) byPath[entry.path] = entry.status;
      set({ byPath });
    } catch (err) {
      console.error("Failed to load git status:", err);
    }
  },
}));

// Severity order used when a directory's status is derived from its descendants (most severe
// change wins), and when picking a single color if a path somehow matched more than one bucket.
const SEVERITY: GitFileStatus[] = ["modified", "added", "untracked"];

/// Status for `path` itself, or — when `isDir` — the most severe status among any entry nested
/// under it. Returns `null` when there's nothing to show.
export function statusFor(
  byPath: Record<string, GitFileStatus>,
  path: string,
  isDir: boolean
): GitFileStatus | null {
  if (!isDir) return byPath[path] ?? null;

  const prefix = `${path}/`;
  let best: GitFileStatus | null = null;
  for (const entryPath in byPath) {
    if (path !== "" && !entryPath.startsWith(prefix)) continue;
    const status = byPath[entryPath];
    if (best === null || SEVERITY.indexOf(status) < SEVERITY.indexOf(best)) {
      best = status;
    }
  }
  return best;
}

export const GIT_STATUS_DOT_CLASS: Record<GitFileStatus, string> = {
  modified: "bg-amber-400",
  added: "bg-emerald-400",
  untracked: "bg-blue-400",
};

export const GIT_STATUS_TEXT_CLASS: Record<GitFileStatus, string> = {
  modified: "text-amber-400",
  added: "text-emerald-400",
  untracked: "text-blue-400",
};
