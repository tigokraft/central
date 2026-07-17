import { useState } from "react";
import { useDrag } from "@use-gesture/react";
import { Frame as FrameIcon } from "lucide-react";
import { useCanvasStore, CanvasNode, beginHistoryBatch, endHistoryBatch } from "../../../store/canvasStore";

interface ActionFrameNodeProps {
  node: CanvasNode;
}

// A purely visual Figma-style grouping frame: no ports, no execution behavior. The
// Orchestrator drops Coder/Reviewer/Test Runner nodes inside one of these to keep a
// generated plan visually scoped as a single unit on the canvas.
export default function ActionFrameNode({ node }: ActionFrameNodeProps) {
  const { id, data } = node;
  const updateNodeDimensions = useCanvasStore((state) => state.updateNodeDimensions);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);

  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleText, setTitleText] = useState(data.label || "Action Frame");

  const bindResize = useDrag(
    ({ delta: [dx, dy], first, last, event }) => {
      event.stopPropagation();
      if (first) beginHistoryBatch();
      const zoom = useCanvasStore.getState().viewport.zoom;
      const nextWidth = Math.max(320, node.width + dx / zoom);
      const nextHeight = Math.max(200, node.height + dy / zoom);
      updateNodeDimensions(id, nextWidth, nextHeight);
      if (last) endHistoryBatch();
    },
    { pointer: { capture: false } }
  );

  const handleTitleSubmit = () => {
    setIsEditingTitle(false);
    beginHistoryBatch();
    updateNodeData(id, { label: titleText });
    endHistoryBatch();
  };

  return (
    <div className="relative w-full h-full select-none">
      {/* Figma-style label pinned above the frame border */}
      <div className="absolute -top-6 left-0 flex items-center gap-1.5 text-slate-400">
        <FrameIcon size={12} className="text-slate-400 shrink-0" />
        {isEditingTitle ? (
          <input
            type="text"
            value={titleText}
            onChange={(e) => setTitleText(e.target.value)}
            onBlur={handleTitleSubmit}
            onKeyDown={(e) => e.key === "Enter" && handleTitleSubmit()}
            autoFocus
            data-nodrag
            className="bg-slate-950 border border-emerald-500/50 rounded px-1 text-[11px] font-semibold text-slate-200 focus:outline-none"
          />
        ) : (
          <span
            onDoubleClick={() => setIsEditingTitle(true)}
            className="text-[11px] font-semibold tracking-wide cursor-pointer hover:text-slate-200 transition-colors"
            title="Double click to rename"
          >
            {data.label || "Action Frame"}
          </span>
        )}
      </div>

      {/* Frame body: dashed border, translucent fill, children render as sibling nodes on top */}
      <div className="w-full h-full rounded-xl border-2 border-dashed border-slate-600/50 bg-slate-500/[0.03] transition-colors hover:border-slate-500/60" />

      {/* Resize Handle */}
      <div
        className="absolute bottom-0 right-0 w-3.5 h-3.5 cursor-se-resize resize-handle flex items-end justify-end p-0.5 z-40"
        {...(bindResize() as any)}
      >
        <svg width="8" height="8" viewBox="0 0 8 8" className="text-slate-500/60 hover:text-slate-400">
          <line x1="6" y1="0" x2="6" y2="8" stroke="currentColor" strokeWidth="1" />
          <line x1="0" y1="6" x2="8" y2="6" stroke="currentColor" strokeWidth="1" />
        </svg>
      </div>
    </div>
  );
}
