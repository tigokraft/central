import React, { useRef, useState, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  Terminal,
  Box,
  MessageSquare,
  Brain,
  Frame as FrameIcon
} from "lucide-react";
import { useCanvasStore, CanvasNode } from "../../store/canvasStore";
import SVGEdgeLayer from "./SVGEdgeLayer";
import CanvasNodeWrapper from "./CanvasNodeWrapper";
import Minimap from "./Minimap";
import Toolbar from "./Toolbar";

// Nodes
import TerminalNode from "./nodes/TerminalNode";
import ActionContainerNode from "./nodes/ActionContainerNode";
import PromptNode from "./nodes/PromptNode";
import MemoryNode from "./nodes/MemoryNode";
import ActionFrameNode from "./nodes/ActionFrameNode";
import EphemeralActionNode from "./nodes/EphemeralActionNode";

interface InfiniteCanvasProps {
  showMinimap: boolean;
}

interface NodeEventPayload {
  nodeId: string;
  message?: string;
  output?: string;
  exitCode?: number;
  retryCount?: number;
  maxRetries?: number;
}

interface CableHandoffPayload {
  sourceNodeId: string;
  targetNodeId: string;
  commitSha: string;
  insertions: number;
  deletions: number;
  filesChanged: number;
}

export default function InfiniteCanvas({ showMinimap }: InfiniteCanvasProps) {
  const nodes = useCanvasStore((state) => state.nodes);
  const viewport = useCanvasStore((state) => state.viewport);
  const activeTool = useCanvasStore((state) => state.activeTool);
  const panViewport = useCanvasStore((state) => state.panViewport);
  const zoomViewport = useCanvasStore((state) => state.zoomViewport);
  const setActiveTool = useCanvasStore((state) => state.setActiveTool);
  const addNode = useCanvasStore((state) => state.addNode);
  const updateNodeDimensions = useCanvasStore((state) => state.updateNodeDimensions);
  const setSelectedNodeIds = useCanvasStore((state) => state.setSelectedNodeIds);
  const selectedNodeIds = useCanvasStore((state) => state.selectedNodeIds);
  const deleteNode = useCanvasStore((state) => state.deleteNode);

  const containerRef = useRef<HTMLDivElement>(null);
  const spacePressed = useRef(false);
  const [isSpaceActive, setIsSpaceActive] = useState(false);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; canvasX: number; canvasY: number; type: "canvas" | "node"; nodeId?: string } | null>(null);

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
      } else if (e.key === "Backspace" || e.key === "Delete") {
        if (selectedNodeIds.length > 0) {
          selectedNodeIds.forEach((id) => deleteNode(id));
          setSelectedNodeIds([]);
        }
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
        const rect = container.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const clampedDelta = Math.min(Math.max(e.deltaY, -80), 80);
        const zoomFactor = 1 - clampedDelta * 0.0012;
        zoomViewport(zoomFactor, mouseX, mouseY);
      } else {
        let dx = e.deltaX;
        let dy = e.deltaY;
        if (e.shiftKey && dx === 0) {
          dx = dy;
          dy = 0;
        }
        // Scale delta for smoother native panning without clamping jumps
        panViewport(-dx * 0.5, -dy * 0.5);
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

  // Track the live cursor position in canvas space so quick-launch actions (e.g. the
  // Toolbar's agent launcher buttons) can drop new nodes right where the user is looking.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handlePointerTrack = (e: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      const { viewport, setPointerCanvasPosition } = useCanvasStore.getState();
      const canvasX = (e.clientX - rect.left - viewport.x) / viewport.zoom;
      const canvasY = (e.clientY - rect.top - viewport.y) / viewport.zoom;
      setPointerCanvasPosition(canvasX, canvasY);
    };

    container.addEventListener("pointermove", handlePointerTrack);
    return () => container.removeEventListener("pointermove", handlePointerTrack);
  }, []);

  // Graph execution event wiring: syncs node/edge visuals to the Rust execute_graph run
  useEffect(() => {
    const unlistenFns: Array<() => void> = [];

    const setup = async () => {
      const { setNodeStatus, setEdgeExecStateForTarget, setCableDiffStat, setPipelineRunning } =
        useCanvasStore.getState();

      unlistenFns.push(
        await listen<NodeEventPayload>("node-start", (e) => {
          setNodeStatus(e.payload.nodeId, "running");
          setEdgeExecStateForTarget(e.payload.nodeId, "streaming");
        })
      );
      unlistenFns.push(
        await listen<NodeEventPayload>("node-streaming", (e) => {
          setNodeStatus(e.payload.nodeId, "running");
          setEdgeExecStateForTarget(e.payload.nodeId, "streaming");
        })
      );
      unlistenFns.push(
        await listen<NodeEventPayload>("node-success", (e) => {
          setNodeStatus(e.payload.nodeId, "success");
          setEdgeExecStateForTarget(e.payload.nodeId, "success");
        })
      );
      unlistenFns.push(
        await listen<NodeEventPayload>("node-retry", (e) => {
          setNodeStatus(e.payload.nodeId, "error");
          setEdgeExecStateForTarget(e.payload.nodeId, "fail");
        })
      );
      unlistenFns.push(
        await listen<NodeEventPayload>("node-fail", (e) => {
          setNodeStatus(e.payload.nodeId, "error");
          setEdgeExecStateForTarget(e.payload.nodeId, "fail");
        })
      );
      unlistenFns.push(
        await listen<CableHandoffPayload>("cable-handoff", (e) => {
          setCableDiffStat(e.payload.sourceNodeId, e.payload.targetNodeId, {
            insertions: e.payload.insertions,
            deletions: e.payload.deletions,
            filesChanged: e.payload.filesChanged,
            commitSha: e.payload.commitSha,
          });
        })
      );
      unlistenFns.push(await listen("graph-complete", () => setPipelineRunning(false)));
      unlistenFns.push(await listen("graph-error", () => setPipelineRunning(false)));
    };

    setup();

    return () => {
      unlistenFns.forEach((fn) => fn());
    };
  }, []);



  const middlePanRef = useRef({ isDown: false, lastX: 0, lastY: 0 });

  // Mouse Interactions for drawing custom Action Container Frames or selection marquees
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Manual middle click pan initialization
    if (e.button === 1) {
      e.preventDefault();
      middlePanRef.current = { isDown: true, lastX: e.clientX, lastY: e.clientY };
      containerRef.current?.setPointerCapture(e.pointerId);
      return;
    }

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

  const updateMarqueeSelection = (startX: number, startY: number, currentX: number, currentY: number) => {
    const left = Math.min(startX, currentX);
    const top = Math.min(startY, currentY);
    const right = Math.max(startX, currentX);
    const bottom = Math.max(startY, currentY);

    const overlapped = nodes
      .filter((n) => n.x < right && n.x + n.width > left && n.y < bottom && n.y + n.height > top)
      .map((n) => n.id);

    setSelectedNodeIds(overlapped);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    // Manual middle click pan handling
    if (middlePanRef.current.isDown) {
      const dx = e.clientX - middlePanRef.current.lastX;
      const dy = e.clientY - middlePanRef.current.lastY;
      middlePanRef.current.lastX = e.clientX;
      middlePanRef.current.lastY = e.clientY;
      panViewport(dx, dy);
      return;
    }

    if (!containerRef.current?.hasPointerCapture(e.pointerId)) return;

    const rect = containerRef.current.getBoundingClientRect();
    const clientX = e.clientX - rect.left;
    const clientY = e.clientY - rect.top;

    const canvasX = (clientX - viewport.x) / viewport.zoom;
    const canvasY = (clientY - viewport.y) / viewport.zoom;

    if (activeTool === "frame" && frameDrawing) {
      setFrameDrawing((prev) =>
        prev ? { ...prev, currentX: canvasX, currentY: canvasY } : null
      );
    } else if (activeTool === "select" && selectionBox) {
      setSelectionBox((prev) =>
        prev ? { ...prev, currentX: canvasX, currentY: canvasY } : null
      );

      // Perform real-time marquee overlapping selection checks
      updateMarqueeSelection(selectionBox.startX, selectionBox.startY, canvasX, canvasY);
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (middlePanRef.current.isDown) {
      middlePanRef.current.isDown = false;
      containerRef.current?.releasePointerCapture(e.pointerId);
      return;
    }

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
    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const clientX = e.clientX - rect.left;
    const clientY = e.clientY - rect.top;
    const canvasX = (clientX - viewport.x) / viewport.zoom;
    const canvasY = (clientY - viewport.y) / viewport.zoom;

    const target = e.target as HTMLElement;
    const nodeEl = target.closest("[data-node-id]");

    if (nodeEl) {
      const nodeId = nodeEl.getAttribute("data-node-id")!;
      if (!selectedNodeIds.includes(nodeId)) {
        setSelectedNodeIds([nodeId]);
      }
      setContextMenu({ x: e.clientX, y: e.clientY, canvasX, canvasY, type: "node", nodeId });
    } else {
      setContextMenu({ x: e.clientX, y: e.clientY, canvasX, canvasY, type: "canvas" });
    }
  };

  const handleAddNodeFromMenu = (type: CanvasNode["type"]) => {
    if (!contextMenu) return;
    addNode(type, contextMenu.canvasX, contextMenu.canvasY);
    setContextMenu(null);
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
      case "memoryNode":
        return <MemoryNode node={node} />;
      case "actionFrameNode":
        return <ActionFrameNode node={node} />;
      case "ephemeralActionNode":
        return <EphemeralActionNode node={node} />;
    }
  };

  // Figma Dot Grid Pattern sizing/alignment calculation
  const gridGap = 16;
  const scaledGap = gridGap * viewport.zoom;
  const gridPosX = viewport.x % scaledGap;
  const gridPosY = viewport.y % scaledGap;

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-slate-900 relative h-full">
      <Toolbar />

      {/* Main Gesture Interactive Container */}
      <div
        id="canvas-container"
        ref={containerRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onContextMenu={handleContextMenu}
        className={`w-full h-full relative overflow-hidden select-none outline-none ${cursorClass}`}
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
          className="absolute inset-0"
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
          {contextMenu.type === "canvas" ? (
            <>
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
                onClick={() => handleAddNodeFromMenu("memoryNode")}
                className="w-full text-left px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800 hover:text-emerald-400 transition-colors flex items-center gap-2 cursor-pointer"
              >
                <Brain size={12} className="text-pink-500" />
                Add Neural Memory
              </button>
              <button
                onClick={() => handleAddNodeFromMenu("actionFrameNode")}
                className="w-full text-left px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800 hover:text-emerald-400 transition-colors flex items-center gap-2 cursor-pointer"
              >
                <FrameIcon size={12} className="text-indigo-400" />
                Add Action Frame
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => {
                  setContextMenu(null);
                }}
                className="w-full text-left px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800 transition-colors flex items-center gap-2 cursor-pointer"
              >
                Run Process
              </button>
              <button
                onClick={() => {
                  setContextMenu(null);
                }}
                className="w-full text-left px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800 transition-colors flex items-center gap-2 cursor-pointer"
              >
                Edit
              </button>
              <button
                onClick={() => {
                  setContextMenu(null);
                }}
                className="w-full text-left px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800 transition-colors flex items-center gap-2 cursor-pointer"
              >
                Change Color
              </button>
              <div className="h-px w-full bg-slate-800 my-1" />
              <button
                onClick={() => {
                  deleteNode(contextMenu.nodeId!);
                  setContextMenu(null);
                }}
                className="w-full text-left px-3 py-1.5 text-xs text-slate-300 hover:bg-red-900/50 hover:text-red-400 transition-colors flex items-center gap-2 cursor-pointer"
              >
                Delete Node
              </button>
            </>
          )}
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
