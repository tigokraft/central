import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCanvasStore } from "../../store/canvasStore";
import { getNodesBounds } from "../../lib/canvasGeometry";

interface MinimapProps {
  containerWidth: number;
  containerHeight: number;
}

export default function Minimap({ containerWidth, containerHeight }: MinimapProps) {
  const nodes = useCanvasStore((state) => state.nodes);
  const viewport = useCanvasStore((state) => state.viewport);
  const setViewport = useCanvasStore((state) => state.setViewport);
  const mapRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Calculate the bounds of all nodes
  const bounds = useMemo(() => {
    const raw = getNodesBounds(nodes);
    if (!raw) {
      return { minX: 0, minY: 0, maxX: 1000, maxY: 1000, width: 1000, height: 1000 };
    }

    // Add padding around bounds
    const padding = 200;
    const minX = raw.minX - padding;
    const minY = raw.minY - padding;
    const maxX = raw.maxX + padding;
    const maxY = raw.maxY + padding;

    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
  }, [nodes]);

  // Map canvas coordinates to minimap coordinates (150x100 box)
  const mapWidth = 150;
  const mapHeight = 100;

  const scaleX = mapWidth / bounds.width;
  const scaleY = mapHeight / bounds.height;
  const scale = Math.min(scaleX, scaleY);

  // Offset to center the nodes inside the minimap
  const offsetX = (mapWidth - bounds.width * scale) / 2;
  const offsetY = (mapHeight - bounds.height * scale) / 2;

  const toMapCoords = (cx: number, cy: number) => {
    return {
      x: (cx - bounds.minX) * scale + offsetX,
      y: (cy - bounds.minY) * scale + offsetY,
    };
  };

  // Inverse of toMapCoords: minimap-space point -> canvas-space point.
  const toCanvasCoords = (mx: number, my: number) => {
    return {
      x: (mx - offsetX) / scale + bounds.minX,
      y: (my - offsetY) / scale + bounds.minY,
    };
  };

  // Viewport box in canvas space
  const viewportCanvas = useMemo(() => {
    const w = containerWidth / viewport.zoom;
    const h = containerHeight / viewport.zoom;
    const x = -viewport.x / viewport.zoom;
    const y = -viewport.y / viewport.zoom;
    return { x, y, w, h };
  }, [viewport, containerWidth, containerHeight]);

  const viewPos = toMapCoords(viewportCanvas.x, viewportCanvas.y);
  const viewWidth = viewportCanvas.w * scale;
  const viewHeight = viewportCanvas.h * scale;

  // Centers the main canvas viewport on the canvas-space point under (clientX, clientY),
  // keeping the current zoom level.
  const centerOnClientPoint = useCallback(
    (clientX: number, clientY: number) => {
      const rect = mapRef.current?.getBoundingClientRect();
      if (!rect) return;
      const { x: canvasX, y: canvasY } = toCanvasCoords(clientX - rect.left, clientY - rect.top);
      setViewport({
        x: containerWidth / 2 - canvasX * viewport.zoom,
        y: containerHeight / 2 - canvasY * viewport.zoom,
      });
    },
    [bounds.minX, bounds.minY, offsetX, offsetY, scale, containerWidth, containerHeight, viewport.zoom, setViewport]
  );

  useEffect(() => {
    if (!isDragging) return;
    const handleMove = (e: MouseEvent) => centerOnClientPoint(e.clientX, e.clientY);
    const handleUp = () => setIsDragging(false);
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [isDragging, centerOnClientPoint]);

  return (
    <div
      className="absolute bottom-4 right-4 bg-slate-950/90 border border-slate-800 rounded-lg p-1.5 shadow-overlay overflow-hidden select-none z-40"
      style={{ width: mapWidth + 12, height: mapHeight + 12 }}
    >
      <div
        ref={mapRef}
        className="relative w-full h-full bg-slate-900/60 rounded cursor-crosshair"
        onMouseDown={(e) => {
          setIsDragging(true);
          centerOnClientPoint(e.clientX, e.clientY);
        }}
      >
        {/* Render Miniature Nodes */}
        {nodes.map((node) => {
          const pos = toMapCoords(node.x, node.y);
          const w = node.width * scale;
          const h = node.height * scale;

          const color =
            node.type === "actionContainerNode"
              ? "bg-transparent border border-slate-700"
              : "bg-emerald-500/50 border border-emerald-500/80";

          return (
            <div
              key={node.id}
              style={{
                position: "absolute",
                left: pos.x,
                top: pos.y,
                width: Math.max(2, w),
                height: Math.max(2, h),
              }}
              className={`${color} rounded-sm`}
            />
          );
        })}

        {/* Render Viewport Outline */}
        <div
          style={{
            position: "absolute",
            left: Math.max(0, Math.min(mapWidth, viewPos.x)),
            top: Math.max(0, Math.min(mapHeight, viewPos.y)),
            width: Math.max(4, Math.min(mapWidth, viewWidth)),
            height: Math.max(4, Math.min(mapHeight, viewHeight)),
          }}
          className="border border-emerald-400 bg-emerald-400/5 pointer-events-none rounded-sm"
        />
      </div>
    </div>
  );
}
