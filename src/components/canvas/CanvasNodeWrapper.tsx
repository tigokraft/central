import React, { useRef } from "react";
import { useDrag } from "@use-gesture/react";
import { useCanvasStore, CanvasNode } from "../../store/canvasStore";

interface CanvasNodeWrapperProps {
  node: CanvasNode;
  children: React.ReactNode;
}

export default function CanvasNodeWrapper({ node, children }: CanvasNodeWrapperProps) {
  const updateNodePosition = useCanvasStore((state) => state.updateNodePosition);
  const reparentNode = useCanvasStore((state) => state.reparentNode);
  const activeTool = useCanvasStore((state) => state.activeTool);
  const deleteNode = useCanvasStore((state) => state.deleteNode);
  const selectedNodeIds = useCanvasStore((state) => state.selectedNodeIds);
  const setSelectedNodeIds = useCanvasStore((state) => state.setSelectedNodeIds);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const isSelected = selectedNodeIds.includes(node.id);

  const bindDrag = useDrag(
    ({ delta: [dx, dy], first, last, event, tap }) => {
      // Only drag with select tool
      if (activeTool !== "select") return;

      // Don't drag if interacting with input fields, select elements, buttons, or custom no-drag areas
      const target = event.target as HTMLElement;
      if (target.closest("input, textarea, button, select, .xterm-screen, [data-nodrag], .resize-handle")) {
        return;
      }

      event.stopPropagation();

      // Tap Selection (Click)
      if (tap) {
        const selected = useCanvasStore.getState().selectedNodeIds;
        const isNodeSelected = selected.includes(node.id);
        const isShift = (event as MouseEvent).shiftKey;

        if (isShift) {
          if (isNodeSelected) {
            setSelectedNodeIds(selected.filter((id) => id !== node.id));
          } else {
            setSelectedNodeIds([...selected, node.id]);
          }
        } else {
          setSelectedNodeIds([node.id]);
        }
        return;
      }

      // Drag Selection initialization
      if (first) {
        const selected = useCanvasStore.getState().selectedNodeIds;
        if (!selected.includes(node.id)) {
          if ((event as MouseEvent).shiftKey) {
            setSelectedNodeIds([...selected, node.id]);
          } else {
            setSelectedNodeIds([node.id]);
          }
        }
      }

      const zoom = useCanvasStore.getState().viewport.zoom;

      const nextX = node.x + dx / zoom;
      const nextY = node.y + dy / zoom;

      updateNodePosition(node.id, nextX, nextY, { dx: dx / zoom, dy: dy / zoom });

      if (last) {
        reparentNode(node.id);
      }
    },
    {
      filterTaps: true,
      pointer: { capture: false },
    }
  );

  return (
    <div
      ref={wrapperRef}
      style={{
        position: "absolute",
        left: node.x,
        top: node.y,
        width: node.width,
        height: node.height,
        transformOrigin: "top left",
      }}
      className={`absolute group select-none transition-shadow duration-100 ${
        isSelected
          ? "ring-2 ring-emerald-500 rounded-xl shadow-[0_0_18px_rgba(16,185,129,0.35)] z-20"
          : "z-10"
      }`}
      {...(bindDrag() as any)}
    >
      {/* Node Content Container */}
      <div className="relative w-full h-full">
        {children}
        
        {/* Node Delete Button (visible on hover) */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            deleteNode(node.id);
          }}
          className="absolute -top-2 -right-2 bg-red-600 hover:bg-red-500 text-white rounded-full w-5 h-5 flex items-center justify-center text-[10px] font-bold shadow-lg opacity-0 group-hover:opacity-100 transition-opacity z-50 cursor-pointer"
        >
          ×
        </button>
      </div>
    </div>
  );
}
