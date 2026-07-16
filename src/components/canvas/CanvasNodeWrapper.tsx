import { useRef, useEffect } from "react";
import { useDrag } from "@use-gesture/react";
import { useCanvasStore, CanvasNode } from "../../store/canvasStore";

interface CanvasNodeWrapperProps {
  node: CanvasNode;
  children: React.ReactNode;
}

export default function CanvasNodeWrapper({ node, children }: CanvasNodeWrapperProps) {
  const updateNodePosition = useCanvasStore((state) => state.updateNodePosition);
  const updateNodeDimensions = useCanvasStore((state) => state.updateNodeDimensions);
  const reparentNode = useCanvasStore((state) => state.reparentNode);
  const activeTool = useCanvasStore((state) => state.activeTool);
  const selectedNodeIds = useCanvasStore((state) => state.selectedNodeIds);
  const setSelectedNodeIds = useCanvasStore((state) => state.setSelectedNodeIds);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const isSelected = selectedNodeIds.includes(node.id);
  const isContainer = node.type === "actionContainerNode" || node.type === "actionFrameNode";

  // Automatically measure actual laid-out dimensions and sync to store
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;

    const resizeObserver = new ResizeObserver(() => {
      // Get physical screen client dimensions
      const rect = el.getBoundingClientRect();
      const zoom = useCanvasStore.getState().viewport.zoom;
      
      // Calculate original canvas-space coordinates
      const width = rect.width / zoom;
      const height = rect.height / zoom;

      const storeNode = useCanvasStore.getState().nodes.find((n) => n.id === node.id);
      if (storeNode) {
        const widthDiff = Math.abs(storeNode.width - width);
        const heightDiff = Math.abs(storeNode.height - height);
        
        // Update dimensions if they deviate significantly
        if (widthDiff > 1.5 || heightDiff > 1.5) {
          // Dynamic heights apply to Prompt, Terminal, and Memory cards
          if (!isContainer) {
            updateNodeDimensions(node.id, width, height);
          }
        }
      }
    });

    resizeObserver.observe(el);
    return () => resizeObserver.disconnect();
  }, [node.id, isContainer, updateNodeDimensions]);

  const bindDrag = useDrag(
    ({ delta: [dx, dy], first, last, event, tap }) => {
      if (activeTool !== "select") return;

      const target = event.target as HTMLElement;
      if (target.closest("input, textarea, button, select, .xterm-screen, [data-nodrag], .resize-handle")) {
        return;
      }

      event.stopPropagation();

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
      data-node-id={node.id}
      style={{
        position: "absolute",
        left: node.x,
        top: node.y,
        width: node.width,
        height: isContainer ? node.height : "auto", // auto height layout for dynamic text elements
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
      </div>
    </div>
  );
}
