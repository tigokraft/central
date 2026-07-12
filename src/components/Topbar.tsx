import { useReactFlow } from "@xyflow/react";
import { Play, ZoomIn, ZoomOut, Maximize, Map, Layers } from "lucide-react";

interface TopbarProps {
  showMinimap: boolean;
  setShowMinimap: (show: boolean) => void;
  onRunGraph: () => void;
}

export default function Topbar({ showMinimap, setShowMinimap, onRunGraph }: TopbarProps) {
  const { zoomIn, zoomOut, fitView } = useReactFlow();

  return (
    <div className="h-14 bg-slate-950/90 backdrop-blur-md border-b border-slate-800/80 px-4 flex items-center justify-between select-none z-10">
      {/* Workspace Selector */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 px-2.5 py-1.5 bg-slate-900 border border-slate-800 rounded-lg">
          <Layers size={14} className="text-emerald-400" />
          <select className="bg-transparent text-xs text-slate-300 font-mono focus:outline-none cursor-pointer">
            <option value="central">c:/Users/exxo/Documents/central</option>
            <option value="nodecode">c:/Users/exxo/Documents/nodecode</option>
            <option value="sandbox">c:/Users/exxo/Documents/sandbox</option>
          </select>
        </div>
      </div>

      {/* Center Action */}
      <div>
        <button
          onClick={onRunGraph}
          className="flex items-center gap-2 bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-600 text-slate-950 font-semibold px-4 py-1.5 rounded-lg text-xs tracking-wider transition-all duration-200 shadow-[0_0_15px_rgba(16,185,129,0.2)] hover:shadow-[0_0_20px_rgba(16,185,129,0.4)] cursor-pointer"
        >
          <Play size={12} fill="currentColor" />
          RUN EXECUTION GRAPH
        </button>
      </div>

      {/* Right Canvas Controls */}
      <div className="flex items-center gap-4">
        {/* Zoom Controls */}
        <div className="flex items-center bg-slate-900 border border-slate-800 rounded-lg p-0.5">
          <button
            onClick={() => zoomIn()}
            title="Zoom In"
            className="p-1.5 hover:bg-slate-800 rounded text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
          >
            <ZoomIn size={14} />
          </button>
          <button
            onClick={() => zoomOut()}
            title="Zoom Out"
            className="p-1.5 hover:bg-slate-800 rounded text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
          >
            <ZoomOut size={14} />
          </button>
          <button
            onClick={() => fitView({ duration: 400 })}
            title="Fit View"
            className="p-1.5 hover:bg-slate-800 rounded text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
          >
            <Maximize size={14} />
          </button>
        </div>

        {/* Minimap Toggle */}
        <button
          onClick={() => setShowMinimap(!showMinimap)}
          className={`flex items-center gap-1.5 px-3 py-1.5 border rounded-lg text-xs font-medium transition-all duration-200 cursor-pointer ${
            showMinimap
              ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
              : "bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200"
          }`}
        >
          <Map size={13} />
          Minimap
        </button>
      </div>
    </div>
  );
}
