// Drives an in-progress node drag entirely outside React: mutates the moved node(s)' own DOM
// style directly and recomputes only the edges touching them via nodeDragRegistry/
// edgeDragRegistry, batched into one write per animation frame. Mirrors viewportController's
// ref+RAF pattern so a drag never touches the zustand store (and the full-tree re-render that
// would follow, since no canvas component is memoized) until the gesture ends — see
// CanvasNodeWrapper's bindDrag for the call sites and the final store commit.

import { CanvasNode, CanvasEdge, getHandlePosition, resolveMovingIds } from "../store/canvasStore";
import { findAlignmentGuides, getBezierPath, type Rect } from "./canvasGeometry";
import { nodeDragRegistry } from "./nodeDragRegistry";
import { edgeDragRegistry } from "./edgeDragRegistry";

interface MovingNode {
  id: string;
  baseX: number;
  baseY: number;
  width: number;
  height: number;
}

interface RelevantEdge {
  edgeId: string;
  sourceId: string;
  targetId: string;
  sourceHandle: string;
  targetHandle: string;
  sourceType: CanvasNode["type"];
  targetType: CanvasNode["type"];
}

type DragGuides = { vertical: number[]; horizontal: number[] } | null;

interface ActiveDrag {
  primaryId: string;
  moving: MovingNode[];
  movingById: Map<string, MovingNode>;
  othersById: Map<string, Rect>;
  othersRects: Rect[];
  edges: RelevantEdge[];
  setDragGuides: (guides: DragGuides) => void;
}

export interface DragEndResult {
  dx: number;
  dy: number;
  hadVerticalGuide: boolean;
  hadHorizontalGuide: boolean;
}

class NodeDragController {
  private active: ActiveDrag | null = null;
  private pending: { dx: number; dy: number; zoom: number } | null = null;
  private rafId: number | null = null;

  private lastFinalDx = 0;
  private lastFinalDy = 0;
  private lastGuides: { vertical: number[]; horizontal: number[] } = { vertical: [], horizontal: [] };

  /** Called once on drag start (use-gesture's `first`). Snapshots base positions so every
   * subsequent frame only needs to know the total movement since gesture start. */
  begin(
    primaryId: string,
    selectedIds: string[],
    allNodes: CanvasNode[],
    allEdges: CanvasEdge[],
    setDragGuides: (guides: DragGuides) => void
  ) {
    const nodesToMove = selectedIds.includes(primaryId) ? selectedIds : [primaryId];
    const movingIds = resolveMovingIds(nodesToMove, allNodes);

    const moving: MovingNode[] = [];
    const othersById = new Map<string, Rect>();
    for (const n of allNodes) {
      if (movingIds.has(n.id)) {
        moving.push({ id: n.id, baseX: n.x, baseY: n.y, width: n.width, height: n.height });
      } else {
        othersById.set(n.id, { x: n.x, y: n.y, width: n.width, height: n.height });
      }
    }

    const edges: RelevantEdge[] = [];
    for (const e of allEdges) {
      if (!movingIds.has(e.source) && !movingIds.has(e.target)) continue;
      const sourceNode = allNodes.find((n) => n.id === e.source);
      const targetNode = allNodes.find((n) => n.id === e.target);
      if (!sourceNode || !targetNode) continue;
      edges.push({
        edgeId: e.id,
        sourceId: e.source,
        targetId: e.target,
        sourceHandle: e.sourceHandle,
        targetHandle: e.targetHandle,
        sourceType: sourceNode.type,
        targetType: targetNode.type,
      });
    }

    this.active = {
      primaryId,
      moving,
      movingById: new Map(moving.map((m) => [m.id, m])),
      othersById,
      othersRects: Array.from(othersById.values()),
      edges,
      setDragGuides,
    };
    this.pending = null;
    this.lastFinalDx = 0;
    this.lastFinalDy = 0;
    this.lastGuides = { vertical: [], horizontal: [] };
  }

  /** Called on every pointer-move with the raw (unsnapped) movement since gesture start, in
   * canvas units. Only records the latest value — the actual DOM writes are batched to once
   * per animation frame via `apply`. */
  update(dx: number, dy: number, zoom: number) {
    if (!this.active) return;
    this.pending = { dx, dy, zoom };
    if (this.rafId == null) {
      this.rafId = requestAnimationFrame(() => {
        this.rafId = null;
        this.apply();
      });
    }
  }

  private apply() {
    const active = this.active;
    const pending = this.pending;
    if (!active || !pending) return;
    this.pending = null;

    const primary = active.movingById.get(active.primaryId);
    if (!primary) return;

    const nextX = primary.baseX + pending.dx;
    const nextY = primary.baseY + pending.dy;
    const guides = findAlignmentGuides(
      { x: nextX, y: nextY, width: primary.width, height: primary.height },
      active.othersRects,
      6 / pending.zoom
    );
    const finalDx = pending.dx + guides.snapDx;
    const finalDy = pending.dy + guides.snapDy;

    this.lastFinalDx = finalDx;
    this.lastFinalDy = finalDy;
    this.lastGuides = { vertical: guides.vertical, horizontal: guides.horizontal };

    for (const m of active.moving) {
      const el = nodeDragRegistry.get(m.id);
      if (!el) continue;
      el.style.left = `${m.baseX + finalDx}px`;
      el.style.top = `${m.baseY + finalDy}px`;
    }

    const rectFor = (id: string): Rect | undefined => {
      const moved = active.movingById.get(id);
      if (moved) {
        return { x: moved.baseX + finalDx, y: moved.baseY + finalDy, width: moved.width, height: moved.height };
      }
      return active.othersById.get(id);
    };

    for (const e of active.edges) {
      const sourceRect = rectFor(e.sourceId);
      const targetRect = rectFor(e.targetId);
      if (!sourceRect || !targetRect) continue;
      const start = getHandlePosition({ ...sourceRect, type: e.sourceType } as CanvasNode, e.sourceHandle);
      const end = getHandlePosition({ ...targetRect, type: e.targetType } as CanvasNode, e.targetHandle);
      const d = getBezierPath(start.x, start.y, e.sourceHandle, e.sourceType, end.x, end.y, e.targetHandle, e.targetType);
      edgeDragRegistry.setPath(e.edgeId, d);
    }

    active.setDragGuides(
      guides.vertical.length > 0 || guides.horizontal.length > 0
        ? { vertical: guides.vertical, horizontal: guides.horizontal }
        : null
    );
  }

  /** Called once on drag release (`last`). Flushes any not-yet-applied frame synchronously so
   * the DOM and the returned result reflect the exact drop position, then hands back the total
   * delta (plus whether an alignment guide was active on each axis, for the release-time grid
   * snap) so the caller can commit once to the store. */
  end(): DragEndResult | null {
    if (!this.active) return null;
    if (this.rafId != null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.pending) this.apply();

    const result: DragEndResult = {
      dx: this.lastFinalDx,
      dy: this.lastFinalDy,
      hadVerticalGuide: this.lastGuides.vertical.length > 0,
      hadHorizontalGuide: this.lastGuides.horizontal.length > 0,
    };
    this.active = null;
    return result;
  }
}

export const nodeDragController = new NodeDragController();
