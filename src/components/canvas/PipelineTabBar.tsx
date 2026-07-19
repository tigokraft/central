import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Plus, MoreHorizontal, Pencil, Copy, Trash2 } from "lucide-react";
import { useCanvasStore, flushActivePipelineSave, type CanvasNode, type CanvasEdge, type Viewport } from "../../store/canvasStore";
import { type PipelineMeta } from "../../lib/pipelines";
import Modal from "../ui/Modal";
import Button from "../ui/Button";
import { cn } from "../../lib/cn";

interface PipelineGraph {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  viewport: Viewport;
}

interface PipelineTabBarProps {
  projectId: string;
}

// Horizontal tab strip for a project's pipelines: switch, create, rename (double-click),
// duplicate/delete (via the "..." menu or right-click). Switching flushes the current
// pipeline's pending autosave, loads the target's graph, and hydrates it into canvasStore,
// which also resets undo history so it can't cross pipelines.
export default function PipelineTabBar({ projectId }: PipelineTabBarProps) {
  const activePipelineId = useCanvasStore((state) => state.activePipelineId);
  const pipelineListVersion = useCanvasStore((state) => state.pipelineListVersion);
  const [pipelines, setPipelines] = useState<PipelineMeta[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PipelineMeta | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void refreshPipelines();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, pipelineListVersion]);

  useEffect(() => {
    if (editingId) editInputRef.current?.select();
  }, [editingId]);

  useEffect(() => {
    if (!menuFor) return;
    const close = () => setMenuFor(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menuFor]);

  const refreshPipelines = async () => {
    try {
      const list = await invoke<PipelineMeta[]>("list_pipelines", { projectId });
      setPipelines(list);
      return list;
    } catch (err) {
      console.error("Failed to list pipelines:", err);
      return [];
    }
  };

  const switchTo = async (pipelineId: string) => {
    if (pipelineId === activePipelineId) return;
    try {
      await flushActivePipelineSave();
      const graph = await invoke<PipelineGraph | null>("load_pipeline_graph", { projectId, pipelineId });
      useCanvasStore
        .getState()
        .hydratePipeline(projectId, pipelineId, graph ?? { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } });
    } catch (err) {
      console.error("Failed to switch pipeline:", err);
    }
  };

  const createTab = async () => {
    try {
      const name = `Pipeline ${pipelines.length + 1}`;
      const meta = await invoke<PipelineMeta>("create_pipeline", { projectId, name });
      await refreshPipelines();
      await switchTo(meta.id);
    } catch (err) {
      console.error("Failed to create pipeline:", err);
    }
  };

  const startRename = (pipeline: PipelineMeta) => {
    setMenuFor(null);
    setEditingId(pipeline.id);
    setEditingName(pipeline.name);
  };

  const commitRename = async () => {
    const pipelineId = editingId;
    setEditingId(null);
    if (!pipelineId) return;
    const trimmed = editingName.trim();
    const current = pipelines.find((p) => p.id === pipelineId);
    if (!trimmed || !current || trimmed === current.name) return;
    try {
      await invoke("rename_pipeline", { projectId, pipelineId, name: trimmed });
      await refreshPipelines();
    } catch (err) {
      console.error("Failed to rename pipeline:", err);
    }
  };

  const duplicateTab = async (pipeline: PipelineMeta) => {
    setMenuFor(null);
    try {
      const meta = await invoke<PipelineMeta>("duplicate_pipeline", { projectId, pipelineId: pipeline.id });
      await refreshPipelines();
      await switchTo(meta.id);
    } catch (err) {
      console.error("Failed to duplicate pipeline:", err);
    }
  };

  const confirmDelete = async () => {
    const pipeline = deleteTarget;
    setDeleteTarget(null);
    if (!pipeline) return;
    try {
      if (pipeline.id === activePipelineId) {
        const fallback = pipelines.find((p) => p.id !== pipeline.id);
        if (fallback) await switchTo(fallback.id);
      }
      await invoke("delete_pipeline", { projectId, pipelineId: pipeline.id });
      await refreshPipelines();
    } catch (err) {
      console.error("Failed to delete pipeline:", err);
    }
  };

  return (
    <div className="h-9 bg-slate-950/60 border-b border-slate-800/60 px-2 flex items-center gap-1 select-none shrink-0 overflow-x-auto">
      {pipelines.map((pipeline) => {
        const isActive = pipeline.id === activePipelineId;
        const isEditing = editingId === pipeline.id;
        return (
          <div
            key={pipeline.id}
            onClick={() => void switchTo(pipeline.id)}
            onDoubleClick={() => startRename(pipeline)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenuFor(pipeline.id);
            }}
            className={cn(
              "group relative flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium cursor-pointer transition-colors shrink-0",
              isActive
                ? "bg-slate-800 text-slate-100"
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-900"
            )}
          >
            {isEditing ? (
              <input
                ref={editInputRef}
                autoFocus
                value={editingName}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setEditingName(e.target.value)}
                onBlur={() => void commitRename()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void commitRename();
                  if (e.key === "Escape") setEditingId(null);
                }}
                className="bg-slate-900 border border-emerald-500/50 rounded px-1 py-0.5 text-xs text-slate-100 w-28 focus:outline-none"
              />
            ) : (
              <span className="truncate max-w-[140px]">{pipeline.name}</span>
            )}

            <button
              onClick={(e) => {
                e.stopPropagation();
                setMenuFor(menuFor === pipeline.id ? null : pipeline.id);
              }}
              className={cn(
                "p-0.5 rounded text-slate-500 hover:text-slate-200 hover:bg-slate-700/60 transition-opacity",
                isActive || menuFor === pipeline.id ? "opacity-100" : "opacity-0 group-hover:opacity-100"
              )}
            >
              <MoreHorizontal size={12} />
            </button>

            {menuFor === pipeline.id && (
              <div
                onClick={(e) => e.stopPropagation()}
                className="absolute top-full left-0 mt-1 w-36 bg-slate-900 border border-slate-800 rounded-lg shadow-overlay py-1 z-20"
              >
                <button
                  onClick={() => startRename(pipeline)}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-slate-800 hover:text-slate-100 cursor-pointer"
                >
                  <Pencil size={12} />
                  Rename
                </button>
                <button
                  onClick={() => void duplicateTab(pipeline)}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-slate-800 hover:text-slate-100 cursor-pointer"
                >
                  <Copy size={12} />
                  Duplicate
                </button>
                <button
                  onClick={() => {
                    setMenuFor(null);
                    setDeleteTarget(pipeline);
                  }}
                  disabled={pipelines.length <= 1}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-red-400 hover:bg-slate-800 disabled:opacity-40 disabled:pointer-events-none cursor-pointer"
                >
                  <Trash2 size={12} />
                  Delete
                </button>
              </div>
            )}
          </div>
        );
      })}

      <button
        onClick={() => void createTab()}
        title="New Pipeline"
        className="p-1.5 rounded text-slate-500 hover:text-slate-200 hover:bg-slate-900 transition-colors cursor-pointer shrink-0"
      >
        <Plus size={13} />
      </button>

      {deleteTarget && (
        <Modal onClose={() => setDeleteTarget(null)} width={360}>
          <p className="text-xs font-semibold text-slate-200 uppercase tracking-wide">Delete Pipeline</p>
          <p className="text-xs text-slate-400 mt-2">
            Delete <span className="text-slate-200 font-medium">{deleteTarget.name}</span>? This removes its graph
            permanently and cannot be undone.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={() => void confirmDelete()} className="bg-red-500 hover:bg-red-400 text-slate-950">
              Delete
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
