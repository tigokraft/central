import React, { useMemo } from "react";
import { useCanvasStore } from "../../store/canvasStore";

interface MinimapProps {
  containerWidth: number;
  containerHeight: number;
}

export default function Minimap({ containerWidth, containerHeight }: MinimapProps) {
  const nodes = useCanvasStore((state) => state.nodes);
  const viewport = useCanvasStore((state) => state.viewport);

  // Calculate the bounds of all nodes
  const bounds = useMemo(() => {
    if (nodes.length === 0) {
      return { minX: 0, minY: 0, maxX: 1000, maxY: 1000, width: 1000, height: 1000 };
    }

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

    // Add padding around bounds
    const padding = 200;
    minX -= padding;
    minY -= padding;
    maxX += padding;
    maxY += padding;

    // Ensure some minimum viewport bounds are shown
    const width = maxX - minX;
    const height = maxY - minY;

    return { minX, minY, maxX, maxY, width, height };
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

  return (
    <div
      className="absolute bottom-4 right-4 bg-slate-950/90 border border-slate-800 rounded-lg p-1.5 shadow-2xl overflow-hidden select-none z-40"
      style={{ width: mapWidth + 12, height: mapHeight + 12 }}
    >
      <div className="relative w-full h-full bg-slate-900/60 rounded">
        {/* Render Miniature Nodes */}
        {nodes.map((node) => {
          const pos = toMapCoords(node.x, node.y);
          const w = node.width * scale;
          const h = node.height * scale;

          let color = "bg-emerald-500/50 border border-emerald-500/80";
          if (node.type === "actionContainerNode") {
            color = "bg-transparent border border-slate-700";
          } else if (node.type === "memoryGraphNote") {
            color = "bg-pink-500/50 border border-pink-500/80";
          } else if (node.type === "terminalNode") {
            color = "bg-teal-500/50 border border-teal-500/80";
          }

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
