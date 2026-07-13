import { useRef } from "react";
import { useDrag } from "@use-gesture/react";
import { useCanvasStore, getHandlePosition } from "../../store/canvasStore";

interface PortProps {
  nodeId: string;
  handleId: string;
  type: "source" | "target";
  color?: "emerald" | "pink" | "blue";
  className?: string;
}

export default function Port({ nodeId, handleId, type, color = "emerald", className = "" }: PortProps) {
  const startDraggingEdge = useCanvasStore((state) => state.startDraggingEdge);
  const updateDraggingEdge = useCanvasStore((state) => state.updateDraggingEdge);
  const stopDraggingEdge = useCanvasStore((state) => state.stopDraggingEdge);
  const addEdge = useCanvasStore((state) => state.addEdge);
  
  const portRef = useRef<HTMLDivElement>(null);

  const bindDrag = useDrag(({ active, xy: [x, y], last, event }) => {
    event.stopPropagation();
    
    const store = useCanvasStore.getState();
    const { viewport } = store;
    
    // Compute port coordinate in canvas space
    const container = document.getElementById("canvas-container");
    const containerRect = container?.getBoundingClientRect() || { left: 0, top: 0 };
    
    // Convert physical screen coordinate to container-local coordinate
    const clientX = x - containerRect.left;
    const clientY = y - containerRect.top;

    const rect = portRef.current?.getBoundingClientRect();
    let startX = 0;
    let startY = 0;
    if (rect) {
      const portClientX = rect.left + rect.width / 2 - containerRect.left;
      const portClientY = rect.top + rect.height / 2 - containerRect.top;
      startX = (portClientX - viewport.x) / viewport.zoom;
      startY = (portClientY - viewport.y) / viewport.zoom;
    } else {
      startX = (clientX - viewport.x) / viewport.zoom;
      startY = (clientY - viewport.y) / viewport.zoom;
    }

    const currentX = (clientX - viewport.x) / viewport.zoom;
    const currentY = (clientY - viewport.y) / viewport.zoom;

    if (active) {
      if (!store.draggingEdge) {
        // Grab/Reconnect: Check if this is a target port with an existing edge
        const existingEdge = store.edges.find(
          (e) => e.target === nodeId && e.targetHandle === handleId
        );

        if (type === "target" && existingEdge) {
          const sourceNode = store.nodes.find((n) => n.id === existingEdge.source);
          if (sourceNode) {
            const start = getHandlePosition(sourceNode, existingEdge.sourceHandle);
            store.deleteEdge(existingEdge.id);
            // Start dragging from the original source socket
            startDraggingEdge(existingEdge.source, existingEdge.sourceHandle, start.x, start.y);
          } else {
            startDraggingEdge(nodeId, handleId, startX, startY);
          }
        } else {
          // Normal drag start
          startDraggingEdge(nodeId, handleId, startX, startY);
        }
      } else {
        updateDraggingEdge(currentX, currentY);
      }
    }

    if (last) {
      const dragging = useCanvasStore.getState().draggingEdge;
      if (dragging) {
        const el = document.elementFromPoint(x, y);
        const portEl = el?.closest("[data-port-id]");
        if (portEl) {
          const targetNodeId = portEl.getAttribute("data-node-id")!;
          const targetHandleId = portEl.getAttribute("data-handle-id")!;
          const targetPortType = portEl.getAttribute("data-port-type")!;

          // Can only connect to target (input) handles on other nodes
          if (targetNodeId !== dragging.sourceId && targetPortType === "target") {
            addEdge(dragging.sourceId, dragging.sourceHandle, targetNodeId, targetHandleId);
          }
        }
      }
      stopDraggingEdge();
    }
  });

  const colorConfig = {
    emerald: {
      border: "border-emerald-500",
      hoverBg: "hover:bg-emerald-400",
      dotBg: "bg-emerald-500",
    },
    pink: {
      border: "border-pink-500",
      hoverBg: "hover:bg-pink-400",
      dotBg: "bg-pink-500",
    },
    blue: {
      border: "border-blue-500",
      hoverBg: "hover:bg-blue-400",
      dotBg: "bg-blue-500",
    },
  }[color];

  return (
    <div
      ref={portRef}
      data-port-id={`${nodeId}-${handleId}`}
      data-node-id={nodeId}
      data-handle-id={handleId}
      data-port-type={type}
      className={`w-2.5 h-2.5 rounded-full bg-slate-950 border-2 ${colorConfig.border} ${colorConfig.hoverBg} hover:scale-125 transition-all cursor-crosshair z-30 pointer-events-auto flex items-center justify-center ${className}`}
      {...(bindDrag() as any)}
    >
      <div className={`w-1 h-1 rounded-full ${colorConfig.dotBg}`} />
    </div>
  );
}
