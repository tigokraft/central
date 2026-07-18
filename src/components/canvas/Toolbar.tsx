import { MousePointer, Hand, Square } from "lucide-react";
import { useCanvasStore } from "../../store/canvasStore";

// Figma-style floating tool switcher. View controls (zoom/fit) and the agent launcher buttons
// live in Topbar instead — keeping this bar to just the interaction-mode switcher means it stays
// small enough to never overflow into the editor panel docked beside the canvas.
export default function Toolbar() {
  const activeTool = useCanvasStore((state) => state.activeTool);
  const setActiveTool = useCanvasStore((state) => state.setActiveTool);

  return (
    <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-slate-950/90 backdrop-blur-md border border-slate-800 rounded-xl px-2 py-1.5 flex items-center gap-1 shadow-overlay z-30 select-none">
      <button
        onClick={() => setActiveTool("select")}
        title="Select Tool (V)"
        className={`p-1.5 rounded-lg transition-all cursor-pointer ${
          activeTool === "select"
            ? "bg-emerald-500/10 border border-emerald-500/20 text-emerald-400"
            : "text-slate-400 hover:text-slate-200"
        }`}
      >
        <MousePointer size={15} />
      </button>
      <button
        onClick={() => setActiveTool("hand")}
        title="Hand Tool (H)"
        className={`p-1.5 rounded-lg transition-all cursor-pointer ${
          activeTool === "hand"
            ? "bg-emerald-500/10 border border-emerald-500/20 text-emerald-400"
            : "text-slate-400 hover:text-slate-200"
        }`}
      >
        <Hand size={15} />
      </button>
      <button
        onClick={() => setActiveTool("frame")}
        title="Frame Tool (F)"
        className={`p-1.5 rounded-lg transition-all cursor-pointer ${
          activeTool === "frame"
            ? "bg-emerald-500/10 border border-emerald-500/20 text-emerald-400"
            : "text-slate-400 hover:text-slate-200"
        }`}
      >
        <Square size={15} />
      </button>
    </div>
  );
}
