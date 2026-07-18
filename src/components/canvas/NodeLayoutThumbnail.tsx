import { useEffect, useMemo, useRef, useState } from "react";
import { computeThumbnailLayout, type Rect } from "../../lib/canvasGeometry";

export interface ThumbnailNode extends Rect {
  id: string;
  type: string;
}

export function getNodeBlockClass(type: string): string {
  return type === "actionContainerNode" || type === "actionFrameNode"
    ? "bg-transparent border border-slate-700"
    : "bg-emerald-500/50 border border-emerald-500/80";
}

interface NodeLayoutThumbnailProps {
  nodes: ThumbnailNode[];
  padding?: number;
  className?: string;
}

// Self-sizing abstract layout preview: fills its own container (measured via ResizeObserver)
// and renders each node as a scaled block, same bounds/scale math as Minimap.
export default function NodeLayoutThumbnail({ nodes, padding = 60, className = "" }: NodeLayoutThumbnailProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const layout = useMemo(
    () => (size.width > 0 && size.height > 0 ? computeThumbnailLayout(nodes, size.width, size.height, padding) : null),
    [nodes, size.width, size.height, padding]
  );

  return (
    <div ref={containerRef} className={`relative overflow-hidden ${className}`}>
      {layout &&
        nodes.map((node) => (
          <div
            key={node.id}
            style={{
              position: "absolute",
              left: (node.x - layout.bounds.minX) * layout.scale + layout.offsetX,
              top: (node.y - layout.bounds.minY) * layout.scale + layout.offsetY,
              width: Math.max(2, node.width * layout.scale),
              height: Math.max(2, node.height * layout.scale),
            }}
            className={`rounded-sm ${getNodeBlockClass(node.type)}`}
          />
        ))}
    </div>
  );
}
