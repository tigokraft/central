export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// The visible canvas-space rectangle for a given viewport + container size, used to cull
// offscreen nodes/edges before rendering. `margin` extends the rect outward (in canvas
// units) so items just past the edge don't visibly pop in/out during a small pan.
export function getViewportBounds(
  viewport: { x: number; y: number; zoom: number },
  containerWidth: number,
  containerHeight: number,
  margin = 0
): Bounds {
  const minX = -viewport.x / viewport.zoom - margin;
  const minY = -viewport.y / viewport.zoom - margin;
  const maxX = (containerWidth - viewport.x) / viewport.zoom + margin;
  const maxY = (containerHeight - viewport.y) / viewport.zoom + margin;
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

export function isRectVisible(rect: Rect, viewBounds: Bounds): boolean {
  return (
    rect.x < viewBounds.maxX &&
    rect.x + rect.width > viewBounds.minX &&
    rect.y < viewBounds.maxY &&
    rect.y + rect.height > viewBounds.minY
  );
}

export function getNodesBounds(nodes: Rect[]): Bounds | null {
  if (nodes.length === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  nodes.forEach((n) => {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width);
    maxY = Math.max(maxY, n.y + n.height);
  });

  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

export interface AlignmentGuideResult {
  // Canvas-space x/y positions to draw guide lines at.
  vertical: number[];
  horizontal: number[];
  // Position correction to snap the dragged rect onto the nearest guide, if any.
  snapDx: number;
  snapDy: number;
}

// Figma-style alignment guides: compares the dragged rect's edges/center against every
// other node's edges/center, and snaps + draws a guide line for the closest match per axis
// within `threshold` canvas units.
export function findAlignmentGuides(
  dragged: Rect,
  others: Rect[],
  threshold = 6
): AlignmentGuideResult {
  const draggedXs = [dragged.x, dragged.x + dragged.width / 2, dragged.x + dragged.width];
  const draggedYs = [dragged.y, dragged.y + dragged.height / 2, dragged.y + dragged.height];

  let bestXDist = threshold;
  let bestX: number | null = null;
  let bestDx = 0;
  let bestYDist = threshold;
  let bestY: number | null = null;
  let bestDy = 0;

  for (const other of others) {
    const otherXs = [other.x, other.x + other.width / 2, other.x + other.width];
    const otherYs = [other.y, other.y + other.height / 2, other.y + other.height];

    for (const dx of draggedXs) {
      for (const ox of otherXs) {
        const dist = Math.abs(dx - ox);
        if (dist < bestXDist) {
          bestXDist = dist;
          bestX = ox;
          bestDx = ox - dx;
        }
      }
    }

    for (const dy of draggedYs) {
      for (const oy of otherYs) {
        const dist = Math.abs(dy - oy);
        if (dist < bestYDist) {
          bestYDist = dist;
          bestY = oy;
          bestDy = oy - dy;
        }
      }
    }
  }

  return {
    vertical: bestX !== null ? [bestX] : [],
    horizontal: bestY !== null ? [bestY] : [],
    snapDx: bestDx,
    snapDy: bestDy,
  };
}

// Cable curvature: control points project outward from each handle along the axis implied
// by its side (top/bottom for terminal nodes, left/right for everything else), scaled by
// distance so short hops don't overshoot and long hops don't go limp.
export function getControlPoints(
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

export function getBezierPath(
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

export interface FitViewportOptions {
  padding?: number;
  minZoom?: number;
  maxZoom?: number;
}

// Computes a {x, y, zoom} viewport that frames `bounds` inside a container of the given
// size, matching the canvas's `translate(x, y) scale(zoom)` transform convention (viewport
// x/y are applied before scale, so a canvas point (cx, cy) lands on screen at
// (x + cx*zoom, y + cy*zoom)).
export function computeFitViewport(
  bounds: Bounds,
  containerWidth: number,
  containerHeight: number,
  options: FitViewportOptions = {}
): { x: number; y: number; zoom: number } {
  const padding = options.padding ?? 80;
  const minZoom = options.minZoom ?? 0.15;
  const maxZoom = options.maxZoom ?? 4;

  const availableWidth = Math.max(containerWidth - padding * 2, 1);
  const availableHeight = Math.max(containerHeight - padding * 2, 1);

  const scaleX = availableWidth / Math.max(bounds.width, 1);
  const scaleY = availableHeight / Math.max(bounds.height, 1);
  const zoom = Math.min(Math.max(Math.min(scaleX, scaleY), minZoom), maxZoom);

  const centerX = bounds.minX + bounds.width / 2;
  const centerY = bounds.minY + bounds.height / 2;

  return {
    zoom,
    x: containerWidth / 2 - centerX * zoom,
    y: containerHeight / 2 - centerY * zoom,
  };
}
