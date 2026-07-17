import { useState } from "react";
import { Play, ZoomIn, ZoomOut, Maximize, Map, KeyRound } from "lucide-react";
import { useCanvasStore } from "../store/canvasStore";
import ProviderSettingsModal from "./ProviderSettingsModal";
import Button from "./ui/Button";

interface TopbarProps {
  showMinimap: boolean;
  setShowMinimap: (show: boolean) => void;
}

export default function Topbar({ showMinimap, setShowMinimap }: TopbarProps) {
  const zoomViewport = useCanvasStore((state) => state.zoomViewport);
  const setViewport = useCanvasStore((state) => state.setViewport);
  const runPipeline = useCanvasStore((state) => state.runPipeline);
  const [showProviderSettings, setShowProviderSettings] = useState(false);

  const resetView = () => {
    setViewport({ x: 100, y: 100, zoom: 1 });
  };

  return (
    <div className="h-14 bg-slate-950/90 backdrop-blur-md border-b border-slate-800/80 px-4 flex items-center justify-between select-none z-10 shrink-0">
      {/* Left spacer (workspace name lives on the Home page; canvas is single-project until Phase 3) */}
      <div />

      {/* Center Action */}
      <div>
        <Button variant="primary" size="md" onClick={runPipeline} className="font-semibold tracking-wider">
          <Play size={12} fill="currentColor" />
          RUN EXECUTION GRAPH
        </Button>
      </div>

      {/* Right Canvas Controls */}
      <div className="flex items-center gap-4">
        {/* Zoom Controls */}
        <div className="flex items-center bg-slate-900 border border-slate-800 rounded-lg p-0.5">
          <button
            onClick={() => zoomViewport(1.1)}
            title="Zoom In"
            className="p-1.5 hover:bg-slate-800 rounded text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
          >
            <ZoomIn size={14} />
          </button>
          <button
            onClick={() => zoomViewport(0.9)}
            title="Zoom Out"
            className="p-1.5 hover:bg-slate-800 rounded text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
          >
            <ZoomOut size={14} />
          </button>
          <button
            onClick={resetView}
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

        {/* Provider Settings (BYOK) */}
        <button
          onClick={() => setShowProviderSettings(true)}
          title="Provider Settings"
          className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-900 border border-slate-800 text-slate-400 hover:text-emerald-400 hover:border-emerald-500/30 rounded-lg text-xs font-medium transition-all duration-200 cursor-pointer"
        >
          <KeyRound size={13} />
          Providers
        </button>
      </div>

      {showProviderSettings && <ProviderSettingsModal onClose={() => setShowProviderSettings(false)} />}
    </div>
  );
}
