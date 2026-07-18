import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import { FilePlus, FolderPlus, Pencil, Trash2 } from "lucide-react";
import { useCanvasStore } from "../../store/canvasStore";
import { useEditorStore } from "../../store/editorStore";
import { useGitStatusStore, statusFor } from "../../store/gitStatusStore";
import {
  type FsEntry,
  createDir,
  createFile,
  deletePath,
  joinPath,
  listDir,
  renamePath,
} from "../../lib/workspaceFs";
import IconButton from "../ui/IconButton";
import Modal from "../ui/Modal";
import Button from "../ui/Button";
import FileTreeRow from "./FileTreeRow";

interface Row {
  path: string;
  name: string;
  kind: "file" | "dir";
  depth: number;
}

interface EditState {
  // Directory (relative path, "" for root) the entry being created/renamed lives in.
  dir: string;
  // Set only when renaming an existing entry; absent while creating a new one.
  originalPath?: string;
  kind: "file" | "dir";
  depth: number;
  value: string;
}

interface ContextMenuState {
  x: number;
  y: number;
  row: Row | null; // null = background/root context menu
}

function parentDir(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

// Left-dock file explorer for the active project's on-disk workspace, rendered as one more
// collapsible section in Sidebar.tsx (see DeploymentsTracker/McpServersPanel/RunHistoryPanel for
// the same activeProjectId-from-canvasStore pattern). Directories are lazy-loaded on expand and
// cached by relative path ("" is the workspace root); the cache self-heals via the
// "workspace-fs-changed" watcher event emitted by the Rust side.
export default function FilesPanel() {
  const activeProjectId = useCanvasStore((state) => state.activeProjectId);

  const [childrenCache, setChildrenCache] = useState<Record<string, FsEntry[]>>({});
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const childrenCacheRef = useRef(childrenCache);
  useEffect(() => {
    childrenCacheRef.current = childrenCache;
  }, [childrenCache]);

  const activePath = useEditorStore((state) => state.activePath);
  const openFile = useEditorStore((state) => state.openFile);
  const editorTabs = useEditorStore((state) => state.tabs);
  const closeEditorFile = useEditorStore((state) => state.closeFile);
  const gitStatusByPath = useGitStatusStore((state) => state.byPath);

  const [editing, setEditing] = useState<EditState | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Row | null>(null);
  const [deleteTrashFailed, setDeleteTrashFailed] = useState<string | null>(null);

  const loadDir = useCallback(
    async (dir: string) => {
      if (!activeProjectId) return;
      try {
        const entries = await listDir(activeProjectId, dir);
        setChildrenCache((prev) => ({ ...prev, [dir]: entries }));
      } catch (err) {
        console.error(`Failed to list directory "${dir}":`, err);
      }
    },
    [activeProjectId]
  );

  // Reset everything and load the root whenever the active project changes. The editor's open
  // tabs and the git status map are both scoped to a single project too, so they reset here
  // alongside the tree rather than each owning a duplicate activeProjectId effect.
  useEffect(() => {
    setChildrenCache({});
    setExpandedDirs(new Set());
    setEditing(null);
    setContextMenu(null);
    setDeleteTarget(null);
    useEditorStore.getState().resetForProject(activeProjectId);
    useGitStatusStore.getState().reset(activeProjectId);
    if (activeProjectId) {
      void loadDir("");
      void useGitStatusStore.getState().refresh(activeProjectId);
    }
  }, [activeProjectId, loadDir]);

  // The watcher event only reports which paths changed, not what changed about them; simplest
  // correct response is to refresh every directory the user has actually visited (root plus
  // every expanded dir still in the cache) rather than trying to map changed paths to cache keys.
  // Open editor tabs and the git status map are reconciled the same way, on every event.
  useEffect(() => {
    if (!activeProjectId) return;
    let unlisten: (() => void) | undefined;
    void listen("workspace-fs-changed", () => {
      Object.keys(childrenCacheRef.current).forEach((dir) => void loadDir(dir));
      useEditorStore.getState().handleExternalChange();
      void useGitStatusStore.getState().refresh(activeProjectId);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [activeProjectId, loadDir]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [contextMenu]);

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

  const openInEditor = (path: string) => {
    if (!activeProjectId) return;
    void openFile(activeProjectId, path);
  };

  // Deleting a file or folder should close any editor tabs it (or its descendants) currently
  // has open, rather than leaving them pointing at a now-nonexistent path.
  const closeTabsWithin = (path: string) => {
    Object.keys(editorTabs).forEach((tabPath) => {
      if (tabPath === path || tabPath.startsWith(`${path}/`)) closeEditorFile(tabPath);
    });
  };

  const startCreate = (dir: string, depth: number, kind: "file" | "dir") => {
    setContextMenu(null);
    if (dir !== "" && !expandedDirs.has(dir)) {
      setExpandedDirs((prev) => new Set(prev).add(dir));
      if (!childrenCache[dir]) void loadDir(dir);
    }
    setEditing({ dir, kind, depth, value: "" });
  };

  const startRename = (row: Row) => {
    setContextMenu(null);
    setEditing({
      dir: parentDir(row.path),
      originalPath: row.path,
      kind: row.kind,
      depth: row.depth,
      value: row.name,
    });
  };

  const commitEdit = async () => {
    const edit = editing;
    setEditing(null);
    if (!edit || !activeProjectId) return;
    const name = edit.value.trim();
    if (!name) return;

    try {
      if (edit.originalPath) {
        if (name === edit.originalPath.split("/").pop()) return;
        const to = joinPath(edit.dir, name);
        await renamePath(activeProjectId, edit.originalPath, to);
        // Reopen at the new path rather than trying to rekey the tab in place — simpler, and
        // renaming a file with unsaved edits open is rare enough not to warrant a dedicated path.
        if (editorTabs[edit.originalPath]) {
          closeEditorFile(edit.originalPath);
          openInEditor(to);
        }
      } else {
        const path = joinPath(edit.dir, name);
        if (edit.kind === "file") await createFile(activeProjectId, path);
        else await createDir(activeProjectId, path);
      }
      await loadDir(edit.dir);
    } catch (err) {
      console.error(edit.originalPath ? "Failed to rename:" : "Failed to create:", err);
    }
  };

  const requestDelete = (row: Row) => {
    setContextMenu(null);
    setDeleteTrashFailed(null);
    setDeleteTarget(row);
  };

  const performDelete = async (force: boolean) => {
    const target = deleteTarget;
    if (!target || !activeProjectId) return;
    try {
      await deletePath(activeProjectId, target.path, force);
      setDeleteTarget(null);
      setDeleteTrashFailed(null);
      closeTabsWithin(target.path);
      await loadDir(parentDir(target.path));
    } catch (err) {
      if (force) {
        console.error("Failed to permanently delete:", err);
        setDeleteTarget(null);
        setDeleteTrashFailed(null);
      } else {
        // Moving to the system trash failed (unsupported platform, permissions, etc.) — offer
        // an explicit, separately-confirmed hard delete instead of silently escalating.
        setDeleteTrashFailed(String(err));
      }
    }
  };

  const openContextMenu = (e: ReactMouseEvent, row: Row | null) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, row });
  };

  const rows: Row[] = [];
  const buildRows = (dir: string, depth: number) => {
    const entries = childrenCache[dir];
    if (entries) {
      for (const entry of entries) {
        const path = joinPath(dir, entry.name);
        rows.push({ path, name: entry.name, kind: entry.kind, depth });
        if (entry.kind === "dir" && expandedDirs.has(path)) {
          buildRows(path, depth + 1);
        }
      }
    }
    // New-entry input row, inserted at the end of whichever directory it's being created in.
    if (editing && !editing.originalPath && editing.dir === dir) {
      rows.push({ path: "__creating__", name: "", kind: editing.kind, depth });
    }
  };
  buildRows("", 0);

  if (!activeProjectId) return null;

  const rootLoaded = childrenCache[""] !== undefined;

  return (
    <div>
      <div className="flex items-center justify-end gap-0.5 px-1 pb-1">
        <IconButton title="New File" onClick={() => startCreate("", 0, "file")}>
          <FilePlus size={12} />
        </IconButton>
        <IconButton title="New Folder" onClick={() => startCreate("", 0, "dir")}>
          <FolderPlus size={12} />
        </IconButton>
      </div>

      <div
        className="max-h-56 overflow-y-auto py-0.5"
        onContextMenu={(e) => openContextMenu(e, null)}
      >
        {!rootLoaded ? (
          <div className="text-[10px] text-slate-600 italic px-2 py-1">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="text-[10px] text-slate-600 italic px-2 py-1">Empty workspace.</div>
        ) : (
          rows.map((row) => {
            const isEditingRow =
              row.path === "__creating__" ||
              (editing?.originalPath !== undefined && editing.originalPath === row.path);
            return (
              <FileTreeRow
                key={row.path === "__creating__" ? `creating-${row.depth}` : row.path}
                depth={row.depth}
                name={row.name}
                kind={row.kind}
                isExpanded={expandedDirs.has(row.path)}
                isSelected={activePath === row.path}
                isEditing={isEditingRow}
                editingValue={isEditingRow ? editing?.value ?? "" : undefined}
                gitStatus={statusFor(gitStatusByPath, row.path, row.kind === "dir")}
                onEditingValueChange={(value) => setEditing((prev) => (prev ? { ...prev, value } : prev))}
                onCommitEdit={() => void commitEdit()}
                onCancelEdit={() => setEditing(null)}
                onClick={() => (row.kind === "dir" ? toggleDir(row.path) : openInEditor(row.path))}
                onContextMenu={(e) => openContextMenu(e, row)}
              />
            );
          })
        )}
      </div>

      {contextMenu && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{ position: "fixed", left: contextMenu.x, top: contextMenu.y }}
          className="w-40 bg-slate-900 border border-slate-800 rounded-lg shadow-overlay py-1 z-50"
        >
          {(contextMenu.row === null || contextMenu.row.kind === "dir") && (
            <>
              <button
                onClick={() =>
                  startCreate(
                    contextMenu.row?.path ?? "",
                    contextMenu.row ? contextMenu.row.depth + 1 : 0,
                    "file"
                  )
                }
                className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-slate-800 hover:text-slate-100 cursor-pointer"
              >
                <FilePlus size={12} />
                New File
              </button>
              <button
                onClick={() =>
                  startCreate(
                    contextMenu.row?.path ?? "",
                    contextMenu.row ? contextMenu.row.depth + 1 : 0,
                    "dir"
                  )
                }
                className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-slate-800 hover:text-slate-100 cursor-pointer"
              >
                <FolderPlus size={12} />
                New Folder
              </button>
            </>
          )}
          {contextMenu.row && (
            <>
              <button
                onClick={() => startRename(contextMenu.row as Row)}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-slate-800 hover:text-slate-100 cursor-pointer"
              >
                <Pencil size={12} />
                Rename
              </button>
              <button
                onClick={() => requestDelete(contextMenu.row as Row)}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-red-400 hover:bg-slate-800 cursor-pointer"
              >
                <Trash2 size={12} />
                Delete
              </button>
            </>
          )}
        </div>
      )}

      {deleteTarget && (
        <Modal
          onClose={() => {
            setDeleteTarget(null);
            setDeleteTrashFailed(null);
          }}
          width={360}
        >
          <p className="text-xs font-semibold text-slate-200 uppercase tracking-wide">
            {deleteTrashFailed ? "Permanently Delete" : "Delete"}
          </p>
          {deleteTrashFailed ? (
            <p className="text-xs text-slate-400 mt-2">
              Couldn't move <span className="text-slate-200 font-medium">{deleteTarget.name}</span> to the
              trash ({deleteTrashFailed}). Permanently delete it instead? This cannot be undone.
            </p>
          ) : (
            <p className="text-xs text-slate-400 mt-2">
              Move <span className="text-slate-200 font-medium">{deleteTarget.name}</span> to the trash?
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDeleteTarget(null);
                setDeleteTrashFailed(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void performDelete(!!deleteTrashFailed)}
              className="bg-red-500 hover:bg-red-400 text-slate-950"
            >
              {deleteTrashFailed ? "Delete Permanently" : "Delete"}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
