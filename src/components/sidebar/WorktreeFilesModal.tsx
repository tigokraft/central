import { useCallback, useEffect, useState } from "react";
import { FolderTree } from "lucide-react";
import { type FsEntry, joinPath, listWorktreeDir, readWorktreeFile } from "../../lib/workspaceFs";
import FileTreeRow from "../files/FileTreeRow";
import Modal from "../ui/Modal";

interface WorktreeFilesModalProps {
  projectId: string;
  nodeId: string;
  onClose: () => void;
}

interface Row {
  path: string;
  name: string;
  kind: "file" | "dir";
  depth: number;
}

// Read-only browser for a single node's isolated sandbox worktree (see DeploymentsTracker's
// "Active Worktrees" list) — the only in-app way to see what a materialized task actually
// produced, since that directory is deliberately hidden from the regular Workspace Files tree
// and never auto-merged into the main branch. Deliberately minimal next to FilesPanel.tsx: no
// create/rename/delete/git-status, since this is someone else's (the agent's) ephemeral sandbox,
// not something a user edits directly.
export default function WorktreeFilesModal({ projectId, nodeId, onClose }: WorktreeFilesModalProps) {
  const [childrenCache, setChildrenCache] = useState<Record<string, FsEntry[]>>({});
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [rootError, setRootError] = useState<string | null>(null);

  const loadDir = useCallback(
    async (dir: string) => {
      try {
        const entries = await listWorktreeDir(projectId, nodeId, dir);
        setChildrenCache((prev) => ({ ...prev, [dir]: entries }));
      } catch (err) {
        console.error(`Failed to list worktree directory "${dir}":`, err);
        if (dir === "") setRootError(err instanceof Error ? err.message : String(err));
      }
    },
    [projectId, nodeId]
  );

  useEffect(() => {
    void loadDir("");
  }, [loadDir]);

  const toggleDir = (path: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
        if (!childrenCache[path]) void loadDir(path);
      }
      return next;
    });
  };

  const openFile = async (path: string) => {
    setSelectedPath(path);
    setFileContent(null);
    setFileError(null);
    try {
      setFileContent(await readWorktreeFile(projectId, nodeId, path));
    } catch (err) {
      setFileError(err instanceof Error ? err.message : String(err));
    }
  };

  const rows: Row[] = [];
  const buildRows = (dir: string, depth: number) => {
    const entries = childrenCache[dir];
    if (!entries) return;
    for (const entry of entries) {
      const path = joinPath(dir, entry.name);
      rows.push({ path, name: entry.name, kind: entry.kind, depth });
      if (entry.kind === "dir" && expandedDirs.has(path)) {
        buildRows(path, depth + 1);
      }
    }
  };
  buildRows("", 0);

  const rootLoaded = childrenCache[""] !== undefined || rootError !== null;

  return (
    <Modal onClose={onClose} width={720}>
      <div className="flex items-center justify-between mb-3 pb-2 border-b border-slate-800">
        <div className="flex items-center gap-2 min-w-0">
          <FolderTree size={14} className="text-emerald-400 shrink-0" />
          <span className="text-xs font-semibold text-slate-200 uppercase tracking-wide truncate">
            Worktree Files — {nodeId}
          </span>
        </div>
      </div>

      <div className="flex gap-3 h-96">
        <div className="w-56 shrink-0 border-r border-slate-800 pr-2 overflow-y-auto">
          {!rootLoaded ? (
            <div className="text-[10px] text-slate-600 italic px-1 py-1">Loading…</div>
          ) : rootError ? (
            <div className="text-[10px] text-red-400 px-1 py-1">{rootError}</div>
          ) : rows.length === 0 ? (
            <div className="text-[10px] text-slate-600 italic px-1 py-1">Empty sandbox.</div>
          ) : (
            rows.map((row) => (
              <FileTreeRow
                key={row.path}
                depth={row.depth}
                name={row.name}
                kind={row.kind}
                isExpanded={expandedDirs.has(row.path)}
                isSelected={selectedPath === row.path}
                onClick={() => (row.kind === "dir" ? toggleDir(row.path) : void openFile(row.path))}
              />
            ))
          )}
        </div>

        <div className="flex-1 min-w-0 overflow-auto">
          {!selectedPath ? (
            <div className="text-[11px] text-slate-500 italic p-2">Select a file to preview it.</div>
          ) : fileError ? (
            <div className="text-[11px] text-red-400 p-2">{fileError}</div>
          ) : fileContent === null ? (
            <div className="text-[11px] text-slate-500 italic p-2">Loading…</div>
          ) : (
            <pre className="text-[11px] text-slate-200 font-mono whitespace-pre-wrap p-2">{fileContent}</pre>
          )}
        </div>
      </div>
    </Modal>
  );
}
