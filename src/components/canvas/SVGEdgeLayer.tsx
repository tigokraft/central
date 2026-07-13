import { useCanvasStore, getHandlePosition } from "../../store/canvasStore";

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

  const cp1x = x1 + (dx1 !== 0 ? Math.sign(dx1) * strength : 0);
  const cp1y = y1 + (dy1 !== 0 ? Math.sign(dy1) * strength : 0);
  const cp2x = x2 + (dx2 !== 0 ? Math.sign(dx2) * strength : 0);
  const cp2y = y2 + (dy2 !== 0 ? Math.sign(dy2) * strength : 0);

  return `M ${x1} ${y1} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${x2} ${y2}`;
}

export default function SVGEdgeLayer() {
  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const draggingEdge = useCanvasStore((state) => state.draggingEdge);
  const deleteEdge = useCanvasStore((state) => state.deleteEdge);

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
              stroke="#34d399" /* stroke-emerald-400 */
              strokeWidth={2}
              className="animate-dash"
              filter="url(#glow)"
            />
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
