import React, { useState } from "react";
import { useDrag } from "@use-gesture/react";
import { Box, Settings, ArrowRight, Plus, Trash2 } from "lucide-react";
import { useCanvasStore, CanvasNode } from "../../../store/canvasStore";
import Port from "../Port";
import NodeToolbelt from "./NodeToolbelt";

interface ActionContainerNodeProps {
  node: CanvasNode;
}

export default function ActionContainerNode({ node }: ActionContainerNodeProps) {
  const { id, data } = node;
  const updateNodeDimensions = useCanvasStore((state) => state.updateNodeDimensions);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);

  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleText, setTitleText] = useState(data.label || "Action Container");
  const [newActionText, setNewActionText] = useState("");

  const actionsList = data.actions || [];

  // Bind gesture for bottom-right corner resizing
  const bindResize = useDrag(
    ({ delta: [dx, dy], event }) => {
      event.stopPropagation();
      const zoom = useCanvasStore.getState().viewport.zoom;
      const nextWidth = Math.max(250, node.width + dx / zoom);
      const nextHeight = Math.max(150, node.height + dy / zoom);
      updateNodeDimensions(id, nextWidth, nextHeight);
    },
    {
      pointer: { capture: false },
    }
  );

  const handleTitleSubmit = () => {
    setIsEditingTitle(false);
    updateNodeData(id, { label: titleText });
  };

  const handleAddAction = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newActionText.trim()) return;
    const updatedActions = [...actionsList, newActionText.trim()];
    updateNodeData(id, { actions: updatedActions });
    setNewActionText("");
  };

  const handleDeleteAction = (indexToDelete: number) => {
    const updatedActions = actionsList.filter((_, idx) => idx !== indexToDelete);
    updateNodeData(id, { actions: updatedActions });
  };

  return (
    <div className="relative w-full h-full bg-slate-900/70 backdrop-blur-md border border-slate-800 rounded-xl shadow-2xl overflow-hidden p-4 flex flex-col transition-all hover:border-emerald-500/40 select-none">
      {/* Sockets */}
      <Port
        nodeId={id}
        handleId="input"
        type="target"
        className="absolute -left-1.5 top-1/2 -translate-y-1/2"
      />
      <Port
        nodeId={id}
        handleId="output"
        type="source"
        className="absolute -right-1.5 top-1/2 -translate-y-1/2"
      />

      {/* Header */}
      <div className="flex items-center justify-between mb-3 border-b border-slate-800/80 pb-2 shrink-0">
        <div className="flex items-center gap-2 flex-1 mr-2 min-w-0">
          <Box size={14} className="text-emerald-400 shrink-0" />
          {isEditingTitle ? (
            <input
              type="text"
              value={titleText}
              onChange={(e) => setTitleText(e.target.value)}
              onBlur={handleTitleSubmit}
              onKeyDown={(e) => e.key === "Enter" && handleTitleSubmit()}
              autoFocus
              className="bg-slate-950 border border-emerald-500/50 rounded px-1 text-xs font-semibold text-slate-200 uppercase tracking-wide focus:outline-none w-full"
            />
          ) : (
            <span
              onDoubleClick={() => setIsEditingTitle(true)}
              className="font-semibold text-xs text-slate-200 tracking-wide uppercase truncate cursor-pointer hover:text-emerald-400 transition-colors"
              title="Double click to edit title"
            >
              {data.label || "Action Container"}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <NodeToolbelt nodeId={id} />
          <Settings size={12} className="text-slate-400 cursor-pointer hover:text-emerald-400 shrink-0" />
        </div>
      </div>

      {/* Description */}
      <p className="text-[11px] text-slate-400 mb-3 italic leading-relaxed shrink-0">
        {data.description || "Container encapsulating sub-steps of the pipeline execution."}
      </p>

      {/* Nested Actions List */}
      <div className="flex-1 overflow-y-auto space-y-1.5 pr-1 min-h-0">
        {actionsList.map((action, index) => (
          <div
            key={index}
            className="flex items-center justify-between bg-slate-950/80 border border-slate-800/60 rounded px-2.5 py-1 text-[10px] font-mono text-slate-300 group/action"
          >
            <span className="flex items-center gap-1.5 truncate">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
              <span className="truncate">{action}</span>
            </span>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => handleDeleteAction(index)}
                className="opacity-0 group-hover/action:opacity-100 hover:text-red-400 text-slate-500 transition-all cursor-pointer p-0.5"
                title="Delete action"
              >
                <Trash2 size={10} />
              </button>
              <ArrowRight size={10} className="text-slate-500 shrink-0" />
            </div>
          </div>
        ))}
      </div>

      {/* Add Action Input */}
      <form onSubmit={handleAddAction} className="mt-3 shrink-0 flex gap-1" data-nodrag>
        <input
          type="text"
          value={newActionText}
          onChange={(e) => setNewActionText(e.target.value)}
          placeholder="Add custom task..."
          className="bg-slate-950/90 border border-slate-800 rounded px-2 py-1 text-[10px] text-slate-300 placeholder-slate-600 focus:outline-none focus:border-emerald-500/50 flex-1 font-mono"
        />
        <button
          type="submit"
          className="bg-slate-800 hover:bg-emerald-500 hover:text-slate-950 text-slate-300 px-2 rounded flex items-center justify-center transition-colors cursor-pointer"
        >
          <Plus size={11} />
        </button>
      </form>

      {/* Resize Handle */}
      <div
        className="absolute bottom-0 right-0 w-3.5 h-3.5 cursor-se-resize resize-handle flex items-end justify-end p-0.5 z-40"
        {...(bindResize() as any)}
      >
        <svg width="8" height="8" viewBox="0 0 8 8" className="text-slate-500 hover:text-emerald-400">
          <line x1="6" y1="0" x2="6" y2="8" stroke="currentColor" strokeWidth="1" />
          <line x1="0" y1="6" x2="8" y2="6" stroke="currentColor" strokeWidth="1" />
        </svg>
      </div>
    </div>
  );
}
