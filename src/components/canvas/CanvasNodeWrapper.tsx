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

  const wrapperRef = useRef<HTMLDivElement>(null);

  const bindDrag = useDrag(
    ({ delta: [dx, dy], last, event }) => {
      // Only drag with select tool
      if (activeTool !== "select") return;

      // Don't drag if interacting with input fields, select elements, buttons, or custom no-drag areas
      const target = event.target as HTMLElement;
      if (target.closest("input, textarea, button, select, .xterm-screen, [data-nodrag], .resize-handle")) {
        return;
      }

      event.stopPropagation();
      const zoom = useCanvasStore.getState().viewport.zoom;

      const nextX = node.x + dx / zoom;
      const nextY = node.y + dy / zoom;

      updateNodePosition(node.id, nextX, nextY, { dx: dx / zoom, dy: dy / zoom });

      if (last) {
        reparentNode(node.id);
      }
    },
    {
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
      className="absolute group select-none"
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
