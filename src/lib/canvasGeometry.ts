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
