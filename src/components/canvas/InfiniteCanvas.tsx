import { useRef, useState, useEffect } from "react";
import { useGesture } from "@use-gesture/react";
import {
  MousePointer,
  Hand,
  Square,
  ZoomIn,
  ZoomOut,
  Maximize,
  Terminal,
  Box,
  MessageSquare,
  Brain
} from "lucide-react";
import { useCanvasStore, CanvasNode } from "../../store/canvasStore";
import SVGEdgeLayer from "./SVGEdgeLayer";
import CanvasNodeWrapper from "./CanvasNodeWrapper";
import Minimap from "./Minimap";

// Nodes
import TerminalNode from "./nodes/TerminalNode";
import ActionContainerNode from "./nodes/ActionContainerNode";
import PromptNode from "./nodes/PromptNode";
import MemoryGraphNote from "./nodes/MemoryGraphNote";

interface InfiniteCanvasProps {
  showMinimap: boolean;
}

export default function InfiniteCanvas({ showMinimap }: InfiniteCanvasProps) {
  const nodes = useCanvasStore((state) => state.nodes);
  const viewport = useCanvasStore((state) => state.viewport);
  const activeTool = useCanvasStore((state) => state.activeTool);
  const panViewport = useCanvasStore((state) => state.panViewport);
  const zoomViewport = useCanvasStore((state) => state.zoomViewport);
  const setViewport = useCanvasStore((state) => state.setViewport);
  const setActiveTool = useCanvasStore((state) => state.setActiveTool);
  const addNode = useCanvasStore((state) => state.addNode);
  const updateNodeDimensions = useCanvasStore((state) => state.updateNodeDimensions);
  const setSelectedNodeIds = useCanvasStore((state) => state.setSelectedNodeIds);

  const containerRef = useRef<HTMLDivElement>(null);
  const spacePressed = useRef(false);
  const [isSpaceActive, setIsSpaceActive] = useState(false);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    canvasX: number;
    canvasY: number;
  } | null>(null);

  // Frame creation state
  const [frameDrawing, setFrameDrawing] = useState<{
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
  } | null>(null);

  // Marquee selection box state
  const [selectionBox, setSelectionBox] = useState<{
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
  } | null>(null);

  // Monitor container size for minimap mapping
  useEffect(() => {
    if (!containerRef.current) return;
    const resizeObserver = new ResizeObserver((entries) => {
      for (let entry of entries) {
        setDimensions({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });
    resizeObserver.observe(containerRef.current);
    return () => resizeObserver.disconnect();
  }, []);

  // Keyboard Shortcuts & Spacebar panning hook
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement;
      if (activeEl?.tagName === "INPUT" || activeEl?.tagName === "TEXTAREA" || activeEl?.hasAttribute("contenteditable")) {
        return;
      }

      if (e.key === " " && !spacePressed.current) {
        e.preventDefault();
        spacePressed.current = true;
        setIsSpaceActive(true);
      }

      if (e.key.toLowerCase() === "v") {
        setActiveTool("select");
      } else if (e.key.toLowerCase() === "h") {
        setActiveTool("hand");
      } else if (e.key.toLowerCase() === "f") {
        setActiveTool("frame");
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === " ") {
        spacePressed.current = false;
        setIsSpaceActive(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [setActiveTool]);

  // Butter-smooth Native Wheel panning, trackpad pinch support, and horizontal Shift+wheel scroll
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheelNative = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey) {
        // Zoom centered on current mouse coordinates
        const rect = container.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        
        // Clamp wheel delta to prevent large jumps, then scale smoothly
        const clampedDelta = Math.min(Math.max(e.deltaY, -80), 80);
        const zoomFactor = 1 - clampedDelta * 0.0012;
        zoomViewport(zoomFactor, mouseX, mouseY);
      } else {
        let dx = e.deltaX;
        let dy = e.deltaY;
        if (e.shiftKey && dx === 0) {
          // Translate Shift+wheel vertical roll into horizontal pan
          dx = dy;
          dy = 0;
        }
        panViewport(-dx, -dy);
      }
    };

    container.addEventListener("wheel", handleWheelNative, { passive: false });
    return () => {
      container.removeEventListener("wheel", handleWheelNative);
    };
  }, [panViewport, zoomViewport]);

  // Context Menu and Clicks closing
  useEffect(() => {
    const closeMenu = () => setContextMenu(null);
    window.addEventListener("click", closeMenu);
    return () => window.removeEventListener("click", closeMenu);
  }, []);

  // Bind Pan Dragging using @use-gesture/react (leaving zoom and scroll wheel to native)
  const bindGestures = useGesture(
    {
      onDrag: ({ delta: [dx, dy], event }) => {
        const isSpaceDrag = spacePressed.current;
        const isMiddleClick = (event as MouseEvent).button === 1;
        const isHand = activeTool === "hand";

        if (isHand || isSpaceDrag || isMiddleClick) {
          event.preventDefault();
          panViewport(dx, dy);
        }
      },
    },
    {
      drag: {
        filterTaps: true,
        filterButtons: (e: any) => e.button === 0 || e.button === 1,
      },
    }
  );

  // Mouse Interactions for drawing custom Action Container Frames or selection marquees
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest("[data-node-id]") || e.button !== 0) return;

    const rect = containerRef.current!.getBoundingClientRect();
    const clientX = e.clientX - rect.left;
    const clientY = e.clientY - rect.top;

    const canvasX = (clientX - viewport.x) / viewport.zoom;
    const canvasY = (clientY - viewport.y) / viewport.zoom;

    containerRef.current!.setPointerCapture(e.pointerId);

    if (activeTool === "frame") {
      setFrameDrawing({
        startX: canvasX,
        startY: canvasY,
        currentX: canvasX,
        currentY: canvasY,
      });
    } else if (activeTool === "select") {
      // Clear selections unless holding shift
      if (!e.shiftKey) {
        setSelectedNodeIds([]);
      }
      setSelectionBox({
        startX: canvasX,
        startY: canvasY,
        currentX: canvasX,
        currentY: canvasY,
      });
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = containerRef.current!.getBoundingClientRect();
    const clientX = e.clientX - rect.left;
    const clientY = e.clientY - rect.top;

    const canvasX = (clientX - viewport.x) / viewport.zoom;
    const canvasY = (clientY - viewport.y) / viewport.zoom;

    if (frameDrawing) {
      setFrameDrawing((prev) =>
        prev ? { ...prev, currentX: canvasX, currentY: canvasY } : null
      );
    } else if (selectionBox) {
      setSelectionBox((prev) =>
        prev ? { ...prev, currentX: canvasX, currentY: canvasY } : null
      );

      // Perform real-time marquee overlapping selection checks
      const left = Math.min(selectionBox.startX, canvasX);
      const top = Math.min(selectionBox.startY, canvasY);
      const right = Math.max(selectionBox.startX, canvasX);
      const bottom = Math.max(selectionBox.startY, canvasY);

      const overlapped = nodes
        .filter((n) => n.x < right && n.x + n.width > left && n.y < bottom && n.y + n.height > top)
        .map((n) => n.id);

      setSelectedNodeIds(overlapped);
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    containerRef.current!.releasePointerCapture(e.pointerId);

    if (frameDrawing) {
      const left = Math.min(frameDrawing.startX, frameDrawing.currentX);
      const top = Math.min(frameDrawing.startY, frameDrawing.currentY);
      const width = Math.abs(frameDrawing.currentX - frameDrawing.startX);
      const height = Math.abs(frameDrawing.currentY - frameDrawing.startY);

      if (width > 25 && height > 25) {
        const nodeType = "actionContainerNode";
        const nodeId = addNode(nodeType, left, top);
        updateNodeDimensions(nodeId, width, height);
      } else {
        // Single click drops default frame
        addNode("actionContainerNode", frameDrawing.startX - 170, frameDrawing.startY - 120);
      }
      setFrameDrawing(null);
      setActiveTool("select");
    }

    if (selectionBox) {
      setSelectionBox(null);
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const rect = containerRef.current!.getBoundingClientRect();
    const clientX = e.clientX - rect.left;
    const clientY = e.clientY - rect.top;

    const canvasX = (clientX - viewport.x) / viewport.zoom;
    const canvasY = (clientY - viewport.y) / viewport.zoom;

    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      canvasX,
      canvasY,
    });
  };

  const handleAddNodeFromMenu = (type: CanvasNode["type"]) => {
    if (!contextMenu) return;
    addNode(type, contextMenu.canvasX, contextMenu.canvasY);
    setContextMenu(null);
  };

  const resetView = () => {
    setViewport({ x: 100, y: 100, zoom: 1 });
  };

  // Cursor style logic
  let cursorClass = "cursor-default";
  if (isSpaceActive || activeTool === "hand") {
    cursorClass = "cursor-grab active:cursor-grabbing";
  } else if (activeTool === "frame") {
    cursorClass = "cursor-crosshair";
  }

  // Render correct node based on its type
  const renderNode = (node: CanvasNode) => {
    switch (node.type) {
      case "terminalNode":
        return <TerminalNode node={node} />;
      case "actionContainerNode":
        return <ActionContainerNode node={node} />;
      case "promptNode":
        return <PromptNode node={node} />;
      case "memoryGraphNote":
        return <MemoryGraphNote node={node} />;
    }
  };

  // Figma Dot Grid Pattern sizing/alignment calculation
  const gridGap = 16;
  const scaledGap = gridGap * viewport.zoom;
  const gridPosX = viewport.x % scaledGap;
  const gridPosY = viewport.y % scaledGap;

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-slate-900 relative h-full">
      {/* Floating Figma Toolbar */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-slate-950/90 backdrop-blur-md border border-slate-800 rounded-xl px-4 py-2 flex items-center gap-6 shadow-2xl z-30 select-none">
        {/* Tools */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => setActiveTool("select")}
            title="Select Tool (V)"
            className={`p-1.5 rounded-lg transition-all cursor-pointer ${
              activeTool === "select"
                ? "bg-emerald-500/10 border border-emerald-500/20 text-emerald-400"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <MousePointer size={15} />
          </button>
          <button
            onClick={() => setActiveTool("hand")}
            title="Hand Tool (H)"
            className={`p-1.5 rounded-lg transition-all cursor-pointer ${
              activeTool === "hand"
                ? "bg-emerald-500/10 border border-emerald-500/20 text-emerald-400"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <Hand size={15} />
          </button>
          <button
            onClick={() => setActiveTool("frame")}
            title="Frame Tool (F)"
            className={`p-1.5 rounded-lg transition-all cursor-pointer ${
              activeTool === "frame"
                ? "bg-emerald-500/10 border border-emerald-500/20 text-emerald-400"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <Square size={15} />
          </button>
        </div>

        <div className="h-4 w-px bg-slate-800" />

        {/* View Controls */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => zoomViewport(1.1)}
            title="Zoom In"
            className="p-1.5 hover:bg-slate-800 rounded text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
          >
            <ZoomIn size={14} />
          </button>
          <span className="text-[10px] text-slate-400 font-mono w-10 text-center select-none">
            {Math.round(viewport.zoom * 100)}%
          </span>
          <button
            onClick={() => zoomViewport(0.9)}
            title="Zoom Out"
            className="p-1.5 hover:bg-slate-800 rounded text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
          >
            <ZoomOut size={14} />
          </button>
          <button
            onClick={resetView}
            title="Reset View"
            className="p-1.5 hover:bg-slate-800 rounded text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
          >
            <Maximize size={14} />
          </button>
        </div>
      </div>

      {/* Main Gesture Interactive Container */}
      <div
        ref={containerRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onContextMenu={handleContextMenu}
        className={`w-full h-full relative overflow-hidden select-none outline-none ${cursorClass}`}
        {...(bindGestures() as any)}
      >
        {/* Figma Infinite Dot Grid Background */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundImage: "radial-gradient(circle, #334155 1.2px, transparent 1.2px)",
            backgroundSize: `${scaledGap}px ${scaledGap}px`,
            backgroundPosition: `${gridPosX}px ${gridPosY}px`,
            pointerEvents: "none",
          }}
        />

        {/* Viewport Zoom & Pan Matrix Scale */}
        <div
          style={{
            transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
            transformOrigin: "0 0",
          }}
          className="absolute inset-0 pointer-events-none"
        >
          {/* Custom SVG Edge Layer */}
          <SVGEdgeLayer />

          {/* Node Render Loop */}
          {nodes.map((node) => (
            <CanvasNodeWrapper key={node.id} node={node}>
              {renderNode(node)}
            </CanvasNodeWrapper>
          ))}

          {/* Action Frame Preview drawing */}
          {frameDrawing && (() => {
            const left = Math.min(frameDrawing.startX, frameDrawing.currentX);
            const top = Math.min(frameDrawing.startY, frameDrawing.currentY);
            const w = Math.abs(frameDrawing.currentX - frameDrawing.startX);
            const h = Math.abs(frameDrawing.currentY - frameDrawing.startY);

            return (
              <div
                style={{
                  position: "absolute",
                  left,
                  top,
                  width: w,
                  height: h,
                  pointerEvents: "none",
                }}
                className="border-2 border-dashed border-emerald-500 bg-emerald-500/5 rounded-lg z-50"
              />
            );
          })()}

          {/* Marquee Selection Box drawing */}
          {selectionBox && (() => {
            const left = Math.min(selectionBox.startX, selectionBox.currentX);
            const top = Math.min(selectionBox.startY, selectionBox.currentY);
            const w = Math.abs(selectionBox.currentX - selectionBox.startX);
            const h = Math.abs(selectionBox.currentY - selectionBox.startY);

            return (
              <div
                style={{
                  position: "absolute",
                  left,
                  top,
                  width: w,
                  height: h,
                  pointerEvents: "none",
                }}
                className="border border-emerald-500/55 bg-emerald-500/5 rounded z-50"
              />
            );
          })()}
        </div>
      </div>

      {/* Custom Context Menu */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-slate-950/95 backdrop-blur-md border border-slate-800 rounded-lg shadow-2xl py-1.5 w-52 select-none"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => handleAddNodeFromMenu("terminalNode")}
            className="w-full text-left px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800 hover:text-emerald-400 transition-colors flex items-center gap-2 cursor-pointer"
          >
            <Terminal size={12} className="text-emerald-500" />
            Add Terminal Node
          </button>
          <button
            onClick={() => handleAddNodeFromMenu("actionContainerNode")}
            className="w-full text-left px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800 hover:text-emerald-400 transition-colors flex items-center gap-2 cursor-pointer"
          >
            <Box size={12} className="text-blue-500" />
            Add Action Container
          </button>
          <button
            onClick={() => handleAddNodeFromMenu("promptNode")}
            className="w-full text-left px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800 hover:text-emerald-400 transition-colors flex items-center gap-2 cursor-pointer"
          >
            <MessageSquare size={12} className="text-purple-500" />
            Add Prompt Node
          </button>
          <button
            onClick={() => handleAddNodeFromMenu("memoryGraphNote")}
            className="w-full text-left px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800 hover:text-emerald-400 transition-colors flex items-center gap-2 cursor-pointer"
          >
            <Brain size={12} className="text-pink-500" />
            Add Memory Graph Note
          </button>
        </div>
      )}

      {/* Custom native Minimap */}
      {showMinimap && (
        <Minimap
          containerWidth={dimensions.width}
          containerHeight={dimensions.height}
        />
      )}

      {/* Background Watermark */}
      <div className="absolute top-20 right-6 pointer-events-none select-none z-0">
        <div className="text-[120px] font-bold text-slate-800/10 font-mono tracking-wider">
          CENTRAL
        </div>
      </div>
    </div>
  );
}
