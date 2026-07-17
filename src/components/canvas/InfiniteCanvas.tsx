import React, { useRef, useState, useEffect, useMemo } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  Terminal,
  Box,
  MessageSquare,
  Brain,
  Frame as FrameIcon
} from "lucide-react";
import { useCanvasStore, CanvasNode, beginHistoryBatch, endHistoryBatch } from "../../store/canvasStore";
import { getViewportBounds, isRectVisible, type Bounds } from "../../lib/canvasGeometry";
import { viewportController, computeTransformStyle, computeGridStyle, type Viewport } from "../../lib/viewportController";
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

// Node types with a live backend process/listener tied to mount (PTY sessions, ephemeral
// run event subscriptions) — these must never be culled while offscreen, or panning them
// out of view would kill the running process.
const ALWAYS_MOUNTED_TYPES: CanvasNode["type"][] = ["terminalNode", "ephemeralActionNode"];

// Generous canvas-space margin so nodes don't visibly pop in/out right at the viewport edge.
// Culling bounds now come from a throttled live-viewport snapshot (~120ms cadence, see
// viewportController) rather than every render, so the margin also has to absorb however far
// a fast pan/momentum fling can travel within one throttle window.
const CULL_MARGIN = 640;

// Figma-style alignment guide lines, shown while dragging a node near another. Reads
// `dragGuides` via its own store subscription (updated every frame during a drag by
// nodeDragController) so only this leaf re-renders per frame — not the whole InfiniteCanvas
// tree, which would defeat the point of driving node/edge drag updates imperatively.
function DragGuideLines({ viewBounds }: { viewBounds: Bounds }) {
  const dragGuides = useCanvasStore((state) => state.dragGuides);

  return (
    <>
      {dragGuides?.vertical.map((x) => (
        <div
          key={`v-${x}`}
          style={{
            position: "absolute",
            left: x,
            top: viewBounds.minY,
            width: 1,
            height: viewBounds.height,
            pointerEvents: "none",
          }}
          className="bg-emerald-400 z-50"
        />
      ))}
      {dragGuides?.horizontal.map((y) => (
        <div
          key={`h-${y}`}
          style={{
            position: "absolute",
            left: viewBounds.minX,
            top: y,
            width: viewBounds.width,
            height: 1,
            pointerEvents: "none",
          }}
          className="bg-emerald-400 z-50"
        />
      ))}
    </>
  );
}

export default function InfiniteCanvas({ showMinimap }: InfiniteCanvasProps) {
  const nodes = useCanvasStore((state) => state.nodes);
  const activeTool = useCanvasStore((state) => state.activeTool);
  const setActiveTool = useCanvasStore((state) => state.setActiveTool);
  const addNode = useCanvasStore((state) => state.addNode);
  const updateNodeDimensions = useCanvasStore((state) => state.updateNodeDimensions);
  const setSelectedNodeIds = useCanvasStore((state) => state.setSelectedNodeIds);
  const selectedNodeIds = useCanvasStore((state) => state.selectedNodeIds);
  const deleteNode = useCanvasStore((state) => state.deleteNode);
  const zoomToFit = useCanvasStore((state) => state.zoomToFit);

  const containerRef = useRef<HTMLDivElement>(null);
  const transformElRef = useRef<HTMLDivElement>(null);
  const gridElRef = useRef<HTMLDivElement>(null);
  const spacePressed = useRef(false);
  const [isSpaceActive, setIsSpaceActive] = useState(false);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });

  // Throttled mirror of the live viewport (see viewportController), used only for viewport
  // culling bounds so offscreen nodes don't visibly pop in/out during a pan — everything else
  // that needs the viewport reads viewportController.getViewport() directly or writes the DOM
  // imperatively, so this is the only viewport-driven re-render source left in this component.
  const [liveViewport, setLiveViewport] = useState<Viewport>(() => viewportController.getViewport());

  useEffect(() => viewportController.subscribeLive(setLiveViewport), []);

  useEffect(() => {
    viewportController.attachDom(transformElRef.current, gridElRef.current);
    return () => viewportController.detachDom();
  }, []);

  // Computed once for the very first paint (before attachDom's effect has run) and never
  // recomputed afterwards — the identical value on every re-render means React's reconciler
  // never touches these style properties again, leaving viewportController's direct per-frame
  // DOM writes as their sole owner. Deriving these from `liveViewport` (reactive, throttled)
  // instead would make React re-stamp a stale value over the controller's live writes on
  // every unrelated re-render (node update, selection change, etc.).
  const initialTransformStyle = useRef(computeTransformStyle(viewportController.getViewport())).current;
  const initialGridStyle = useRef(computeGridStyle(viewportController.getViewport())).current;
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

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        // Cmd/Ctrl+Z to undo, Cmd/Ctrl+Shift+Z to redo
        e.preventDefault();
        const temporal = useCanvasStore.temporal.getState();
        if (e.shiftKey) temporal.redo();
        else temporal.undo();
      } else if (e.key.toLowerCase() === "v") {
        setActiveTool("select");
      } else if (e.key.toLowerCase() === "h") {
        setActiveTool("hand");
      } else if (e.key.toLowerCase() === "f") {
        setActiveTool("frame");
      } else if (e.key === "Backspace" || e.key === "Delete") {
        if (selectedNodeIds.length > 0) {
          beginHistoryBatch();
          selectedNodeIds.forEach((id) => deleteNode(id));
          endHistoryBatch();
          setSelectedNodeIds([]);
        }
      } else if (e.shiftKey && (e.key === "!" || e.key === "1")) {
        // Shift+1: zoom to fit everything (Figma convention)
        e.preventDefault();
        zoomToFit();
      } else if (e.shiftKey && (e.key === "@" || e.key === "2")) {
        // Shift+2: zoom to fit the current selection
        e.preventDefault();
        if (selectedNodeIds.length > 0) zoomToFit(selectedNodeIds);
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

    // Trackpad two-finger pans fire a rapid burst of wheel events with no explicit
    // "release" signal, so momentum is launched from a smoothed (EMA) velocity once a short
    // gap (RELEASE_GAP_MS) passes with no further wheel events — the same idle-gap idiom the
    // controller's own debounced store commit uses.
    const RELEASE_GAP_MS = 120;
    const velocity = { vx: 0, vy: 0, lastT: 0 };
    let releaseTimer: number | null = null;

    const clearReleaseTimer = () => {
      if (releaseTimer != null) {
        window.clearTimeout(releaseTimer);
        releaseTimer = null;
      }
    };

    const handleWheelNative = (e: WheelEvent) => {
      e.preventDefault();
      clearReleaseTimer();

      if (e.ctrlKey) {
        // Pinch/ctrl-zoom isn't a pan gesture — drop any velocity being tracked so a stray
        // pinch mid-swipe doesn't launch momentum from a stale direction afterwards.
        velocity.vx = 0;
        velocity.vy = 0;
        velocity.lastT = performance.now();

        const rect = container.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const clampedDelta = Math.min(Math.max(e.deltaY, -80), 80);
        const zoomFactor = 1 - clampedDelta * 0.0012;
        // Direct, 1:1 controller write — no store round-trip, no React re-render per tick.
        viewportController.zoomBy(zoomFactor, mouseX, mouseY);
        return;
      }

      let dx = e.deltaX;
      let dy = e.deltaY;
      if (e.shiftKey && dx === 0) {
        dx = dy;
        dy = 0;
      }
      // Scale delta for smoother native panning without clamping jumps
      const panDx = -dx * 0.5;
      const panDy = -dy * 0.5;
      viewportController.panBy(panDx, panDy);

      // Exponential moving average of per-frame (~16.7ms) velocity, so one jittery event
      // doesn't set a wild launch speed for the momentum decay below.
      const now = performance.now();
      const dt = Math.max(now - velocity.lastT, 1);
      velocity.lastT = now;
      const instVx = (panDx / dt) * 16.7;
      const instVy = (panDy / dt) * 16.7;
      velocity.vx = velocity.vx * 0.7 + instVx * 0.3;
      velocity.vy = velocity.vy * 0.7 + instVy * 0.3;

      releaseTimer = window.setTimeout(() => {
        releaseTimer = null;
        viewportController.startMomentum(velocity.vx, velocity.vy);
        velocity.vx = 0;
        velocity.vy = 0;
      }, RELEASE_GAP_MS);
    };

    container.addEventListener("wheel", handleWheelNative, { passive: false });
    return () => {
      clearReleaseTimer();
      container.removeEventListener("wheel", handleWheelNative);
    };
  }, []);

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
      const viewport = viewportController.getViewport();
      const { setPointerCanvasPosition } = useCanvasStore.getState();
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

    const viewport = viewportController.getViewport();
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
      viewportController.panBy(dx, dy);
      return;
    }

    if (!containerRef.current?.hasPointerCapture(e.pointerId)) return;

    const rect = containerRef.current.getBoundingClientRect();
    const clientX = e.clientX - rect.left;
    const clientY = e.clientY - rect.top;

    const viewport = viewportController.getViewport();
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
    const viewport = viewportController.getViewport();
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

  // Viewport culling: skip rendering nodes well outside the visible area. Terminal/ephemeral
  // nodes are exempt (see ALWAYS_MOUNTED_TYPES) since unmounting them would tear down their
  // live PTY/process lifecycle.
  const viewBounds = useMemo(
    () => getViewportBounds(liveViewport, dimensions.width, dimensions.height, CULL_MARGIN),
    [liveViewport, dimensions.width, dimensions.height]
  );
  const visibleNodes = useMemo(
    () => nodes.filter((n) => ALWAYS_MOUNTED_TYPES.includes(n.type) || isRectVisible(n, viewBounds)),
    [nodes, viewBounds]
  );

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
        {/* Figma Infinite Dot Grid Background — style written directly by viewportController
            every animation frame (see attachDom), not via React state, so panning/zooming
            doesn't force a re-render. Initial inline style avoids a flash before mount. */}
        <div
          ref={gridElRef}
          style={{
            position: "absolute",
            inset: 0,
            backgroundImage: "radial-gradient(circle, #334155 1.2px, transparent 1.2px)",
            pointerEvents: "none",
            ...initialGridStyle,
          }}
        />

        {/* Viewport Zoom & Pan Matrix Scale — transform written directly by
            viewportController every animation frame instead of via React re-render. */}
        <div
          ref={transformElRef}
          style={{
            transform: initialTransformStyle,
            transformOrigin: "0 0",
          }}
          className="absolute inset-0"
        >
          {/* Custom SVG Edge Layer */}
          <SVGEdgeLayer viewBounds={viewBounds} />

          {/* Node Render Loop */}
          {visibleNodes.map((node) => (
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

          <DragGuideLines viewBounds={viewBounds} />
        </div>
      </div>

      {/* Custom Context Menu */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-slate-950/95 backdrop-blur-md border border-slate-800 rounded-lg shadow-overlay py-1.5 w-52 select-none"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.type === "canvas" ? (
            <>
              <button
                onClick={() => handleAddNodeFromMenu("terminalNode")}
                className="w-full text-left px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800 hover:text-emerald-400 transition-colors flex items-center gap-2 cursor-pointer"
              >
                <Terminal size={12} className="text-slate-400" />
                Add Terminal Node
              </button>
              <button
                onClick={() => handleAddNodeFromMenu("actionContainerNode")}
                className="w-full text-left px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800 hover:text-emerald-400 transition-colors flex items-center gap-2 cursor-pointer"
              >
                <Box size={12} className="text-slate-400" />
                Add Action Container
              </button>
              <button
                onClick={() => handleAddNodeFromMenu("promptNode")}
                className="w-full text-left px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800 hover:text-emerald-400 transition-colors flex items-center gap-2 cursor-pointer"
              >
                <MessageSquare size={12} className="text-slate-400" />
                Add Prompt Node
              </button>
              <button
                onClick={() => handleAddNodeFromMenu("memoryNode")}
                className="w-full text-left px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800 hover:text-emerald-400 transition-colors flex items-center gap-2 cursor-pointer"
              >
                <Brain size={12} className="text-slate-400" />
                Add Neural Memory
              </button>
              <button
                onClick={() => handleAddNodeFromMenu("actionFrameNode")}
                className="w-full text-left px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800 hover:text-emerald-400 transition-colors flex items-center gap-2 cursor-pointer"
              >
                <FrameIcon size={12} className="text-slate-400" />
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
