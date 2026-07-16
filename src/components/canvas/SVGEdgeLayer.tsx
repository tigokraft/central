import { useCanvasStore, getHandlePosition } from "../../store/canvasStore";

function getControlPoints(
  x1: number,
  y1: number,
  handle1Id: string,
  node1Type: string,
  x2: number,
  y2: number,
  handle2Id: string,
  node2Type: string
) {
  // Determine direction of handle 1
  let dx1 = 0;
  let dy1 = 0;
  if (node1Type === "terminalNode") {
    if (handle1Id === "done" || handle1Id === "bottom" || handle1Id === "output") {
      dy1 = 60;
    } else {
      dy1 = -60;
    }
  } else {
    if (handle1Id === "trigger" || handle1Id === "input" || handle1Id === "left") {
      dx1 = -60;
    } else {
      dx1 = 60;
    }
  }

  // Determine direction of handle 2
  let dx2 = 0;
  let dy2 = 0;
  if (node2Type === "terminalNode") {
    if (handle2Id === "done" || handle2Id === "bottom" || handle2Id === "output") {
      dy2 = 60;
    } else {
      dy2 = -60;
    }
  } else {
    if (handle2Id === "trigger" || handle2Id === "input" || handle2Id === "left") {
      dx2 = -60;
    } else {
      dx2 = 60;
    }
  }

  const dist = Math.hypot(x2 - x1, y2 - y1);
  const strength = Math.min(dist * 0.4, 100);

  return {
    cp1x: x1 + (dx1 !== 0 ? Math.sign(dx1) * strength : 0),
    cp1y: y1 + (dy1 !== 0 ? Math.sign(dy1) * strength : 0),
    cp2x: x2 + (dx2 !== 0 ? Math.sign(dx2) * strength : 0),
    cp2y: y2 + (dy2 !== 0 ? Math.sign(dy2) * strength : 0),
  };
}

function getBezierPath(
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
  return `M ${x1} ${y1} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${x2} ${y2}`;
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

export default function SVGEdgeLayer() {
  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const draggingEdge = useCanvasStore((state) => state.draggingEdge);
  const deleteEdge = useCanvasStore((state) => state.deleteEdge);
  const edgeExecState = useCanvasStore((state) => state.edgeExecState);
  const cableDiffStats = useCanvasStore((state) => state.cableDiffStats);

  return (
    <svg className="absolute inset-0 pointer-events-none w-full h-full overflow-visible z-0">
      <defs>
        <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <marker
          id="arrow"
          viewBox="0 0 10 10"
          refX="6"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 1.5 L 8 5 L 0 8.5 Z" fill="#34d399" />
        </marker>
        <marker
          id="arrow-pink"
          viewBox="0 0 10 10"
          refX="6"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 1.5 L 8 5 L 0 8.5 Z" fill="#f472b6" />
        </marker>
        <marker
          id="arrow-cyan"
          viewBox="0 0 10 10"
          refX="6"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 1.5 L 8 5 L 0 8.5 Z" fill="#22d3ee" />
        </marker>
        <marker
          id="arrow-red"
          viewBox="0 0 10 10"
          refX="6"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 1.5 L 8 5 L 0 8.5 Z" fill="#ef4444" />
        </marker>
      </defs>

      {/* Render existing connections */}
      {edges.map((edge) => {
        const sourceNode = nodes.find((n) => n.id === edge.source);
        const targetNode = nodes.find((n) => n.id === edge.target);

        if (!sourceNode || !targetNode) return null;

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

        const isPink = sourceNode.type === "memoryGraphNote" || targetNode.type === "memoryGraphNote";
        let strokeColor = isPink ? "#f472b6" : "#34d399";
        let markerUrl = isPink ? "url(#arrow-pink)" : "url(#arrow)";
        let dashClass = "animate-dash";

        const execState = edgeExecState[edge.id] ?? "idle";
        if (execState === "streaming") {
          strokeColor = "#22d3ee";
          markerUrl = "url(#arrow-cyan)";
          dashClass = "animate-dash-fast";
        } else if (execState === "success") {
          strokeColor = "#34d399";
          markerUrl = "url(#arrow)";
          dashClass = "";
        } else if (execState === "fail") {
          strokeColor = "#ef4444";
          markerUrl = "url(#arrow-red)";
          dashClass = "animate-dash-fast";
        }

        const diffStat = cableDiffStats[edge.id];
        const mid = diffStat
          ? getBezierMidpoint(start.x, start.y, edge.sourceHandle, sourceNode.type, end.x, end.y, edge.targetHandle, targetNode.type)
          : null;

        return (
          <g key={edge.id} className="group">
            {/* Interactive Wide Path for selection and double-click delete */}
            <path
              d={d}
              fill="none"
              stroke="transparent"
              strokeWidth={16}
              className="pointer-events-auto cursor-pointer"
              onDoubleClick={(e) => {
                e.stopPropagation();
                deleteEdge(edge.id);
              }}
            >
              <title>Double click to delete connection</title>
            </path>
            {/* Edge Shadow/Backing */}
            <path
              d={d}
              fill="none"
              stroke="#0f172a"
              strokeWidth={4}
            />
            {/* Active Glowing Cable */}
            <path
              d={d}
              fill="none"
              stroke={strokeColor}
              strokeWidth={2}
              className={dashClass}
              filter="url(#glow)"
              markerEnd={markerUrl}
            />
            {/* Floating Git Diff Badge: agent hand-off stats between Coder and Reviewer nodes */}
            {diffStat && mid && (
              <foreignObject
                x={mid.x - 45}
                y={mid.y - 11}
                width={90}
                height={22}
                className="pointer-events-none overflow-visible"
              >
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
              stroke="#10b981"
              strokeWidth={1.5}
              strokeDasharray="4,4"
              className="opacity-70"
            />
            <circle
              cx={end.x}
              cy={end.y}
              r={4}
              fill="#10b981"
              className="animate-ping"
            />
          </g>
        );
      })()}
    </svg>
  );
}
