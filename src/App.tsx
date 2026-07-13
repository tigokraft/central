import React, { useState } from "react";
import Topbar from "./components/Topbar";
import Sidebar from "./components/Sidebar";
import InfiniteCanvas from "./components/canvas/InfiniteCanvas";
import { useCanvasStore } from "./store/canvasStore";

export default function App() {
  const nodes = useCanvasStore((state) => state.nodes);
  const loadPreset = useCanvasStore((state) => state.loadPreset);
  const [showMinimap, setShowMinimap] = useState(true);

  // Sync active processes with Sidebar monitor
  const activeProcesses = nodes
    .filter((n) => n.type === "terminalNode")
    .map((n) => ({
      id: n.id,
      label: n.data.label,
      isRunning: !!n.data.isRunning,
    }));

  return (
    <div className="flex h-screen w-screen bg-slate-950 text-slate-50 font-sans overflow-hidden">
      <Sidebar
        onLoadPreset={loadPreset}
        activeProcesses={activeProcesses}
      />
      <div className="flex-1 flex flex-col min-w-0 bg-slate-900 relative">
        <Topbar
          showMinimap={showMinimap}
          setShowMinimap={setShowMinimap}
        />
        <div className="flex-1 relative">
          <InfiniteCanvas
            showMinimap={showMinimap}
            setShowMinimap={setShowMinimap}
          />
        </div>
      </div>
    </div>
  );
}
