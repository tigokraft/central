import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { GitBranch, RotateCcw } from "lucide-react";
import { useCanvasStore } from "../../store/canvasStore";

interface WorktreeInfo {
  nodeId: string;
  worktreeName: string;
  path: string;
  baseCommit: string;
  headCommit: string;
}

interface RepoHeadInfo {
  branch: string;
  commitSha: string;
}

function shortSha(sha: string) {
  return sha.slice(0, 7);
}

export default function DeploymentsTracker() {
  const activeProjectId = useCanvasStore((state) => state.activeProjectId);
  const [repoHead, setRepoHead] = useState<RepoHeadInfo | null>(null);
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [rollingBackId, setRollingBackId] = useState<string | null>(null);

  const refresh = async () => {
    if (!activeProjectId) return;
    try {
      setRepoHead(await invoke<RepoHeadInfo>("get_repo_head", { projectId: activeProjectId }));
    } catch (err) {
      console.error("Failed to load repo head:", err);
    }
    try {
      setWorktrees(await invoke<WorktreeInfo[]>("list_active_worktrees", { projectId: activeProjectId }));
    } catch (err) {
      console.error("Failed to load active worktrees:", err);
    }
  };

  useEffect(() => {
    refresh();
    const unlistenFns: Array<() => void> = [];
    const setup = async () => {
      unlistenFns.push(await listen("cable-handoff", () => refresh()));
      unlistenFns.push(await listen("graph-complete", () => refresh()));
      unlistenFns.push(await listen("graph-error", () => refresh()));
    };
    setup();
    return () => unlistenFns.forEach((fn) => fn());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId]);

  const handleRollback = async (nodeId: string) => {
    if (!activeProjectId) return;
    setRollingBackId(nodeId);
    try {
      await invoke("rollback_worktree", { projectId: activeProjectId, nodeId });
      await refresh();
    } catch (err) {
      console.error("Rollback failed:", err);
    } finally {
      setRollingBackId(null);
    }
  };

  return (
    <div className="space-y-1.5 py-1">
      {/* Primary repo branch/SHA */}
      <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-2">
        <div className="flex items-center gap-1.5 text-[9px] font-semibold text-slate-500 uppercase tracking-wider mb-1">
          <GitBranch size={11} className="text-emerald-500" />
          Primary Branch
        </div>
        {repoHead ? (
          <div className="flex items-center justify-between font-mono text-[10px]">
            <span className="text-slate-200 truncate">{repoHead.branch}</span>
            <span className="text-slate-500">{shortSha(repoHead.commitSha)}</span>
          </div>
        ) : (
          <div className="text-[10px] text-slate-600 italic">Not a git repository</div>
        )}
      </div>

      {/* Active isolated worktrees, one per agent node that has run this session */}
      <div className="pt-1.5">
        <div className="text-[9px] font-semibold text-slate-500 uppercase tracking-wider mb-1 px-0.5">
          Active Worktrees
        </div>
        {worktrees.length === 0 ? (
          <div className="text-[10px] text-slate-600 italic px-1">No isolated sandboxes yet.</div>
        ) : (
          <div className="space-y-1.5">
            {worktrees.map((wt) => (
              <div key={wt.nodeId} className="bg-slate-900/60 border border-slate-800 rounded-lg p-2 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] font-mono text-slate-300 truncate">{wt.nodeId}</span>
                  <span className="text-[9px] font-mono text-slate-500 shrink-0">{shortSha(wt.headCommit)}</span>
                </div>
                <button
                  onClick={() => handleRollback(wt.nodeId)}
                  disabled={rollingBackId === wt.nodeId}
                  className="w-full flex items-center justify-center gap-1 text-[9px] font-semibold uppercase tracking-wide bg-slate-800 hover:bg-red-500/20 hover:text-red-400 text-slate-400 rounded px-2 py-1 transition-colors cursor-pointer disabled:opacity-50"
                  title="Hard-reset this node's sandbox worktree back to its base commit"
                >
                  <RotateCcw size={9} />
                  {rollingBackId === wt.nodeId ? "Rolling back..." : "Rollback to Canvas Node State"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
