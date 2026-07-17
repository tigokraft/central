import { useState } from "react";
import Topbar from "../Topbar";
import Sidebar from "../Sidebar";
import InfiniteCanvas from "./InfiniteCanvas";
import OrchestratorBar from "./OrchestratorBar";
import { useCanvasStore } from "../../store/canvasStore";

export default function CanvasWorkspaceView() {
  const nodes = useCanvasStore((state) => state.nodes);
  const [showMinimap, setShowMinimap] = useState(false);

  // Sync active processes with Sidebar monitor
  const activeProcesses = nodes
    .filter((n) => n.type === "terminalNode")
    .map((n) => ({
      id: n.id,
      label: n.data.label,
      isRunning: !!n.data.isRunning,
    }));

  return (
    <div className="flex flex-1 overflow-hidden min-h-0">
      <Sidebar
        activeProcesses={activeProcesses}
      />
      <div className="flex-1 flex flex-col min-w-0 bg-slate-900 relative">
        <Topbar
          showMinimap={showMinimap}
          setShowMinimap={setShowMinimap}
        />
        <OrchestratorBar />
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
