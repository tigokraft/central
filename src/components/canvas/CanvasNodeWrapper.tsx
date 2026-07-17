import { useRef, useEffect } from "react";
import { useDrag } from "@use-gesture/react";
import { useCanvasStore, CanvasNode, beginHistoryBatch, endHistoryBatch } from "../../store/canvasStore";
import { findAlignmentGuides } from "../../lib/canvasGeometry";

interface CanvasNodeWrapperProps {
  node: CanvasNode;
  children: React.ReactNode;
}

// Matches the dotted background grid in InfiniteCanvas so a dropped card visually locks
// into the same rhythm the grid implies.
const SNAP_SIZE = 16;

export default function CanvasNodeWrapper({ node, children }: CanvasNodeWrapperProps) {
  const updateNodePosition = useCanvasStore((state) => state.updateNodePosition);
  const updateNodeDimensions = useCanvasStore((state) => state.updateNodeDimensions);
  const reparentNode = useCanvasStore((state) => state.reparentNode);
  const activeTool = useCanvasStore((state) => state.activeTool);
  const selectedNodeIds = useCanvasStore((state) => state.selectedNodeIds);
  const setSelectedNodeIds = useCanvasStore((state) => state.setSelectedNodeIds);
  const setDragGuides = useCanvasStore((state) => state.setDragGuides);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const isSelected = selectedNodeIds.includes(node.id);
  // Terminal cards are manually resizable/minimizable, so they need a fixed height driven
  // by the store (like the other container types) instead of auto-sizing to content.
  const isContainer =
    node.type === "actionContainerNode" || node.type === "actionFrameNode" || node.type === "terminalNode";

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
        
        // Update dimensions if they deviate significantly. This is a layout measurement,
        // not a user action — it's never wrapped in beginHistoryBatch/endHistoryBatch, and
        // since automatic per-set() history tracking is permanently disabled (see
        // canvasStore.ts), it simply never touches the undo stack.
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
        beginHistoryBatch();
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

      const rawDx = dx / zoom;
      const rawDy = dy / zoom;
      const nextX = node.x + rawDx;
      const nextY = node.y + rawDy;

      // Figma-style alignment guides: snap live onto other nodes' edges/centers while
      // dragging, rather than only correcting to the grid on release.
      const others = useCanvasStore.getState().nodes.filter((n) => n.id !== node.id);
      const guides = findAlignmentGuides(
        { x: nextX, y: nextY, width: node.width, height: node.height },
        others,
        6 / zoom
      );
      const hasGuide = guides.vertical.length > 0 || guides.horizontal.length > 0;
      const finalDx = rawDx + guides.snapDx;
      const finalDy = rawDy + guides.snapDy;

      updateNodePosition(node.id, node.x + finalDx, node.y + finalDy, { dx: finalDx, dy: finalDy });
      setDragGuides(hasGuide ? { vertical: guides.vertical, horizontal: guides.horizontal } : null);

      if (last) {
        // Snap to the nearest grid line on release — but only on the axis that didn't
        // already snap to another node's edge, so aligning two cards doesn't get overridden
        // by the grid a moment later.
        const settledX = node.x + finalDx;
        const settledY = node.y + finalDy;
        const snapCorrectionX = guides.vertical.length > 0 ? 0 : Math.round(settledX / SNAP_SIZE) * SNAP_SIZE - settledX;
        const snapCorrectionY = guides.horizontal.length > 0 ? 0 : Math.round(settledY / SNAP_SIZE) * SNAP_SIZE - settledY;
        if (snapCorrectionX !== 0 || snapCorrectionY !== 0) {
          updateNodePosition(node.id, settledX + snapCorrectionX, settledY + snapCorrectionY, {
            dx: snapCorrectionX,
            dy: snapCorrectionY,
          });
        }
        reparentNode(node.id);
        setDragGuides(null);
        endHistoryBatch();
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
      className={`absolute group select-none ${
        isSelected ? "outline outline-2 outline-emerald-500 rounded-xl z-20" : "z-10"
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
