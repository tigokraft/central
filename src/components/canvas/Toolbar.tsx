import {
  MousePointer,
  Hand,
  Square,
  ZoomIn,
  ZoomOut,
  Maximize,
  TerminalSquare,
  Sparkles,
  Braces,
  SquareTerminal,
} from "lucide-react";
import { useCanvasStore } from "../../store/canvasStore";

const TERMINAL_NODE_WIDTH = 320;
const TERMINAL_NODE_HEIGHT = 190;

interface LauncherPreset {
  key: string;
  label: string;
  command: string;
  icon: typeof TerminalSquare;
}

// Command strings match each tool's actual CLI binary name so the pre-populated command
// runs as-is once the terminal card's Play button (or the user) triggers it.
const LAUNCHER_PRESETS: LauncherPreset[] = [
  { key: "claude-code", label: "Claude Code", command: "claude", icon: Sparkles },
  { key: "gemini-cli", label: "Gemini CLI", command: "gemini", icon: Braces },
  { key: "codex", label: "Codex", command: "codex", icon: SquareTerminal },
  { key: "native-shell", label: "Native Shell", command: "", icon: TerminalSquare },
];

// Figma-style floating toolbar: tool switcher + view controls on the left, one-click agent
// terminal launchers on the right so a fresh session for any CLI is always a single click away.
export default function Toolbar() {
  const activeTool = useCanvasStore((state) => state.activeTool);
  const setActiveTool = useCanvasStore((state) => state.setActiveTool);
  const viewportZoom = useCanvasStore((state) => state.viewport.zoom);
  const zoomViewport = useCanvasStore((state) => state.zoomViewport);
  const setViewport = useCanvasStore((state) => state.setViewport);
  const addNode = useCanvasStore((state) => state.addNode);
  const setSelectedNodeIds = useCanvasStore((state) => state.setSelectedNodeIds);

  const resetView = () => setViewport({ x: 100, y: 100, zoom: 1 });

  // Drops a new terminal card pre-populated with the launcher's command, centered on the
  // last known cursor position over the canvas (or the viewport center if the cursor
  // hasn't crossed the canvas yet, e.g. right after opening the app).
  const handleLaunch = (preset: LauncherPreset) => {
    const { pointerCanvasPosition, viewport } = useCanvasStore.getState();

    let centerX: number;
    let centerY: number;
    if (pointerCanvasPosition) {
      centerX = pointerCanvasPosition.x;
      centerY = pointerCanvasPosition.y;
    } else {
      const container = document.getElementById("canvas-container");
      const rect = container?.getBoundingClientRect();
      const viewportWidth = rect?.width ?? window.innerWidth;
      const viewportHeight = rect?.height ?? window.innerHeight;
      centerX = (viewportWidth / 2 - viewport.x) / viewport.zoom;
      centerY = (viewportHeight / 2 - viewport.y) / viewport.zoom;
    }

    const id = addNode(
      "terminalNode",
      centerX - TERMINAL_NODE_WIDTH / 2,
      centerY - TERMINAL_NODE_HEIGHT / 2,
      {
        data: {
          label: preset.label,
          command: preset.command,
          isRunning: false,
          status: "idle",
        },
      }
    );
    setSelectedNodeIds([id]);
  };

  return (
    <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-slate-950/90 backdrop-blur-md border border-slate-800 rounded-xl px-4 py-2 flex items-center gap-6 shadow-2xl z-30 select-none">
      {/* Tools */}
      <div className="flex items-center gap-1">
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

      <div className="h-4 w-px bg-slate-800" />

      {/* View Controls */}
      <div className="flex items-center gap-1">
        <button
          onClick={() => zoomViewport(1.1)}
          title="Zoom In"
          className="p-1.5 hover:bg-slate-800 rounded text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
        >
          <ZoomIn size={14} />
        </button>
        <span className="text-[10px] text-slate-400 font-mono w-10 text-center select-none">
          {Math.round(viewportZoom * 100)}%
        </span>
        <button
          onClick={() => zoomViewport(0.9)}
          title="Zoom Out"
          className="p-1.5 hover:bg-slate-800 rounded text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
        >
          <ZoomOut size={14} />
        </button>
        <button
          onClick={resetView}
          title="Reset View"
          className="p-1.5 hover:bg-slate-800 rounded text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
        >
          <Maximize size={14} />
        </button>
      </div>

      <div className="h-4 w-px bg-slate-800" />

      {/* Quick-Launch Agent Bar */}
      <div className="flex items-center gap-1">
        {LAUNCHER_PRESETS.map((preset) => {
          const Icon = preset.icon;
          return (
            <button
              key={preset.key}
              onClick={() => handleLaunch(preset)}
              title={`Launch ${preset.label} terminal`}
              className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-[10px] font-mono text-slate-300 bg-slate-900 border border-slate-800 hover:border-emerald-500/50 hover:text-emerald-400 transition-colors cursor-pointer"
            >
              <Icon size={12} />
              <span>+ {preset.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
