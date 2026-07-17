import { useEffect, useRef } from "react";
import { useCanvasStore, getHandlePosition, type CableDiffStat } from "../../store/canvasStore";
import { isRectVisible, getControlPoints, getBezierPath, type Bounds } from "../../lib/canvasGeometry";
import { edgeDragRegistry } from "../../lib/edgeDragRegistry";

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

  useEffect(() => {
    edgeDragRegistry.register(edgeId, { hit: hitRef.current, shadow: shadowRef.current, cable: cableRef.current });
    return () => edgeDragRegistry.unregister(edgeId);
  }, [edgeId]);

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
            title={`Hand-off commit ${diffStat.commitSha.slice(0, 7)}`}
            className="flex items-center justify-center gap-1 w-fit mx-auto bg-slate-950/95 border border-slate-700 rounded-full px-2 py-0.5 text-[9px] font-mono shadow-lg whitespace-nowrap"
          >
            <span className="text-emerald-400">+{diffStat.insertions}</span>
            <span className="text-slate-600">/</span>
            <span className="text-red-400">-{diffStat.deletions}</span>
          </div>
        </foreignObject>
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
