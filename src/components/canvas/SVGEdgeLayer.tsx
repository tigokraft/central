import { useEffect, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { useCanvasStore, getHandlePosition, type CableDiffStat } from "../../store/canvasStore";
import { isRectVisible, getControlPoints, getBezierPath, type Bounds } from "../../lib/canvasGeometry";
import { edgeDragRegistry } from "../../lib/edgeDragRegistry";
import Panel from "../ui/Panel";

// Diffs are immutable per commit, so fetched patch text is cached across every badge/edge
// instance for the lifetime of the app — hovering the same hand-off twice never re-hits IPC.
const diffCache = new Map<string, string>();

const HOVER_FETCH_DELAY_MS = 250;
const HIDE_DELAY_MS = 150;
const POPOVER_WIDTH = 440;
const POPOVER_MAX_HEIGHT = 320;

function clampPopoverPosition(x: number, y: number) {
  const maxX = Math.max(8, window.innerWidth - POPOVER_WIDTH - 8);
  const maxY = Math.max(8, window.innerHeight - POPOVER_MAX_HEIGHT - 8);
  return { x: Math.min(x, maxX), y: Math.min(y, maxY) };
}

function DiffLine({ line }: { line: string }) {
  let colorClass = "text-slate-300";
  if (line.startsWith("+") && !line.startsWith("+++")) colorClass = "text-emerald-400";
  else if (line.startsWith("-") && !line.startsWith("---")) colorClass = "text-red-400";
  else if (line.startsWith("@@")) colorClass = "text-sky-400";
  return <div className={colorClass}>{line || " "}</div>;
}

interface DiffPopoverProps {
  x: number;
  y: number;
  commitSha: string;
  diffText: string | null;
  loading: boolean;
  error: string | null;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

function DiffPopover({ x, y, commitSha, diffText, loading, error, onMouseEnter, onMouseLeave }: DiffPopoverProps) {
  return (
    <Panel
      elevated
      className="fixed z-50 flex flex-col overflow-hidden"
      style={{ left: x, top: y, width: POPOVER_WIDTH, maxHeight: POPOVER_MAX_HEIGHT }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="px-3 py-1.5 border-b border-slate-800 text-[10px] font-mono text-slate-500 shrink-0">
        Hand-off commit {commitSha.slice(0, 7)}
      </div>
      <div className="overflow-auto px-3 py-2 text-[10px] font-mono leading-snug">
        {loading && <div className="text-slate-500">Loading diff…</div>}
        {error && <div className="text-red-400">Failed to load diff: {error}</div>}
        {!loading && !error && diffText !== null && (
          diffText.trim() === "" ? (
            <div className="text-slate-500">No changes</div>
          ) : (
            diffText.split("\n").map((line, i) => <DiffLine key={i} line={line} />)
          )
        )}
      </div>
    </Panel>
  );
}

interface SVGEdgeLayerProps {
  // When provided, edges with neither endpoint node inside these bounds are skipped.
  viewBounds?: Bounds;
}

// Point at t=0.5 along the cable's cubic bezier, used to anchor the floating diff badge.
function getBezierMidpoint(
  x1: number,
  y1: number,
  handle1Id: string,
  node1Type: string,
  x2: number,
  y2: number,
  handle2Id: string,
  node2Type: string
) {
  const { cp1x, cp1y, cp2x, cp2y } = getControlPoints(x1, y1, handle1Id, node1Type, x2, y2, handle2Id, node2Type);
  return {
    x: 0.125 * x1 + 0.375 * cp1x + 0.375 * cp2x + 0.125 * x2,
    y: 0.125 * y1 + 0.375 * cp1y + 0.375 * cp2y + 0.125 * y2,
  };
}

interface EdgeCableProps {
  edgeId: string;
  d: string;
  strokeColor: string;
  markerUrl: string;
  dashClass: string;
  diffStat?: CableDiffStat;
  mid: { x: number; y: number } | null;
  onDelete: () => void;
}

// Renders one cable's paths and registers their DOM refs with edgeDragRegistry, so an
// in-progress node drag (see nodeDragController) can update just this cable's `d` directly
// instead of waiting for a full SVGEdgeLayer re-render.
function EdgeCable({ edgeId, d, strokeColor, markerUrl, dashClass, diffStat, mid, onDelete }: EdgeCableProps) {
  const hitRef = useRef<SVGPathElement>(null);
  const shadowRef = useRef<SVGPathElement>(null);
  const cableRef = useRef<SVGPathElement>(null);

  const fetchTimerRef = useRef<number | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const isMountedRef = useRef(true);

  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);
  const [diffText, setDiffText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    edgeDragRegistry.register(edgeId, { hit: hitRef.current, shadow: shadowRef.current, cable: cableRef.current });
    return () => edgeDragRegistry.unregister(edgeId);
  }, [edgeId]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (fetchTimerRef.current !== null) window.clearTimeout(fetchTimerRef.current);
      if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
    };
  }, []);

  const clearHideTimer = () => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  };

  const scheduleHide = () => {
    clearHideTimer();
    hideTimerRef.current = window.setTimeout(() => setHoverPos(null), HIDE_DELAY_MS);
  };

  const handleBadgeEnter = (e: MouseEvent<HTMLDivElement>) => {
    if (!diffStat) return;
    clearHideTimer();
    setHoverPos(clampPopoverPosition(e.clientX + 14, e.clientY + 14));

    const sha = diffStat.commitSha;
    const cached = diffCache.get(sha);
    if (cached !== undefined) {
      setDiffText(cached);
      setLoading(false);
      setFetchError(null);
      return;
    }

    setDiffText(null);
    setFetchError(null);
    setLoading(true);
    if (fetchTimerRef.current !== null) window.clearTimeout(fetchTimerRef.current);
    fetchTimerRef.current = window.setTimeout(() => {
      invoke<string>("get_diff_for_commit", { sha })
        .then((text) => {
          diffCache.set(sha, text);
          if (isMountedRef.current) {
            setDiffText(text);
            setLoading(false);
          }
        })
        .catch((err) => {
          if (isMountedRef.current) {
            setFetchError(String(err));
            setLoading(false);
          }
        });
    }, HOVER_FETCH_DELAY_MS);
  };

  const handleBadgeLeave = () => {
    if (fetchTimerRef.current !== null) {
      window.clearTimeout(fetchTimerRef.current);
      fetchTimerRef.current = null;
    }
    scheduleHide();
  };

  return (
    <g className="group">
      {/* Interactive Wide Path for selection and double-click delete */}
      <path
        ref={hitRef}
        d={d}
        fill="none"
        stroke="transparent"
        strokeWidth={16}
        className="pointer-events-auto cursor-pointer"
        onDoubleClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
      >
        <title>Double click to delete connection</title>
      </path>
      {/* Edge Shadow/Backing */}
      <path ref={shadowRef} d={d} fill="none" stroke="var(--color-slate-950)" strokeWidth={4} />
      {/* Cable */}
      <path ref={cableRef} d={d} fill="none" stroke={strokeColor} strokeWidth={2} className={dashClass} markerEnd={markerUrl} />
      {/* Floating Git Diff Badge: agent hand-off stats between Coder and Reviewer nodes */}
      {diffStat && mid && (
        <foreignObject x={mid.x - 45} y={mid.y - 11} width={90} height={22} className="pointer-events-none overflow-visible">
          <div
            onMouseEnter={handleBadgeEnter}
            onMouseLeave={handleBadgeLeave}
            className="pointer-events-auto flex items-center justify-center gap-1 w-fit mx-auto bg-slate-950/95 border border-slate-700 rounded-full px-2 py-0.5 text-[9px] font-mono shadow-lg whitespace-nowrap cursor-default"
          >
            <span className="text-emerald-400">+{diffStat.insertions}</span>
            <span className="text-slate-600">/</span>
            <span className="text-red-400">-{diffStat.deletions}</span>
          </div>
        </foreignObject>
      )}
      {/* Diff preview popover: portaled to <body> so it renders at a fixed screen size,
          independent of the canvas's pan/zoom transform. */}
      {hoverPos && diffStat &&
        createPortal(
          <DiffPopover
            x={hoverPos.x}
            y={hoverPos.y}
            commitSha={diffStat.commitSha}
            diffText={diffText}
            loading={loading}
            error={fetchError}
            onMouseEnter={clearHideTimer}
            onMouseLeave={scheduleHide}
          />,
          document.body
        )}
    </g>
  );
}

export default function SVGEdgeLayer({ viewBounds }: SVGEdgeLayerProps) {
  const nodes = useCanvasStore((state) => state.nodes);
  const allEdges = useCanvasStore((state) => state.edges);
  const draggingEdge = useCanvasStore((state) => state.draggingEdge);
  const deleteEdge = useCanvasStore((state) => state.deleteEdge);
  const edgeExecState = useCanvasStore((state) => state.edgeExecState);
  const cableDiffStats = useCanvasStore((state) => state.cableDiffStats);

  return (
    <svg className="absolute inset-0 pointer-events-none w-full h-full overflow-visible z-0">
      <defs>
        <marker
          id="arrow"
          viewBox="0 0 10 10"
          refX="6"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 1.5 L 8 5 L 0 8.5 Z" fill="var(--color-emerald-500)" />
        </marker>
        <marker
          id="arrow-running"
          viewBox="0 0 10 10"
          refX="6"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 1.5 L 8 5 L 0 8.5 Z" fill="var(--color-running)" />
        </marker>
        <marker
          id="arrow-error"
          viewBox="0 0 10 10"
          refX="6"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 1.5 L 8 5 L 0 8.5 Z" fill="var(--color-error)" />
        </marker>
      </defs>

      {/* Render existing connections (skip ones fully outside the visible viewport) */}
      {allEdges.map((edge) => {
        const sourceNode = nodes.find((n) => n.id === edge.source);
        const targetNode = nodes.find((n) => n.id === edge.target);

        if (!sourceNode || !targetNode) return null;

        if (viewBounds && !isRectVisible(sourceNode, viewBounds) && !isRectVisible(targetNode, viewBounds)) {
          return null;
        }

        const start = getHandlePosition(sourceNode, edge.sourceHandle);
        const end = getHandlePosition(targetNode, edge.targetHandle);

        const d = getBezierPath(
          start.x,
          start.y,
          edge.sourceHandle,
          sourceNode.type,
          end.x,
          end.y,
          edge.targetHandle,
          targetNode.type
        );

        let strokeColor = "var(--color-emerald-500)";
        let markerUrl = "url(#arrow)";
        let dashClass = "animate-dash";

        const execState = edgeExecState[edge.id] ?? "idle";
        if (execState === "streaming") {
          strokeColor = "var(--color-running)";
          markerUrl = "url(#arrow-running)";
          dashClass = "animate-dash-fast";
        } else if (execState === "success") {
          strokeColor = "var(--color-emerald-500)";
          markerUrl = "url(#arrow)";
          dashClass = "";
        } else if (execState === "fail") {
          strokeColor = "var(--color-error)";
          markerUrl = "url(#arrow-error)";
          dashClass = "animate-dash-fast";
        }

        const diffStat = cableDiffStats[edge.id];
        const mid = diffStat
          ? getBezierMidpoint(start.x, start.y, edge.sourceHandle, sourceNode.type, end.x, end.y, edge.targetHandle, targetNode.type)
          : null;

        return (
          <EdgeCable
            key={edge.id}
            edgeId={edge.id}
            d={d}
            strokeColor={strokeColor}
            markerUrl={markerUrl}
            dashClass={dashClass}
            diffStat={diffStat}
            mid={mid}
            onDelete={() => deleteEdge(edge.id)}
          />
        );
      })}

      {/* Render temporary connection line while dragging */}
      {draggingEdge && (() => {
        const sourceNode = nodes.find((n) => n.id === draggingEdge.sourceId);
        if (!sourceNode) return null;

        const start = getHandlePosition(sourceNode, draggingEdge.sourceHandle);
        const end = { x: draggingEdge.x, y: draggingEdge.y };

        // Determine target direction approximation based on closest side or horizontal default
        const d = getBezierPath(
          start.x,
          start.y,
          draggingEdge.sourceHandle,
          sourceNode.type,
          end.x,
          end.y,
          "input", // temporary input direction
          "promptNode" // temporary default target type
        );

        return (
          <g>
            <path
              d={d}
              fill="none"
              stroke="var(--color-emerald-500)"
              strokeWidth={1.5}
              strokeDasharray="4,4"
              className="opacity-70"
            />
            <circle
              cx={end.x}
              cy={end.y}
              r={4}
              fill="var(--color-emerald-500)"
              className="animate-ping"
            />
          </g>
        );
      })()}
    </svg>
  );
}
