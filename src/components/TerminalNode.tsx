import { useEffect, useRef } from "react";
import { Handle, Position } from "@xyflow/react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as TerminalIcon, Play } from "lucide-react";

export type TerminalNodeData = {
  label: string;
  command: string;
  isRunning: boolean;
};

interface TerminalNodeProps {
  id: string;
  data: TerminalNodeData;
}

export default function TerminalNode({ data }: TerminalNodeProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const termInstance = useRef<Terminal | null>(null);

  useEffect(() => {
    if (!terminalRef.current) return;

    const term = new Terminal({
      theme: {
        background: "#020617", // slate-950
        foreground: "#10b981", // emerald-500
        cursor: "#10b981",
        selectionBackground: "rgba(16, 185, 129, 0.3)",
      },
      fontSize: 11,
      fontFamily: "Fira Code, ui-monospace, monospace",
      cursorBlink: true,
      rows: 8,
      cols: 40,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);
    fitAddon.fit();

    term.writeln(`$ ${data.command || "echo 'Starting process...'"}`);
    term.writeln("\x1b[33m[info]\x1b[0m Initializing local process...");
    term.writeln("\x1b[32m[success]\x1b[0m Ready. Click 'Run' to execute.");

    termInstance.current = term;

    return () => {
      term.dispose();
    };
  }, [data.command]);

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-lg shadow-2xl overflow-hidden min-w-[320px] transition-all hover:border-emerald-500/50 nodrag">
      <Handle
        type="target"
        position={Position.Left}
        id="trigger"
        style={{ background: "#10b981", width: "8px", height: "8px" }}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="done"
        style={{ background: "#10b981", width: "8px", height: "8px" }}
      />

      {/* Terminal Title Bar */}
      <div className="bg-slate-950 px-3 py-2 flex items-center justify-between border-b border-slate-800">
        <div className="flex items-center gap-2">
          {/* Window Control Dots */}
          <div className="flex gap-1">
            <span className="w-2 h-2 rounded-full bg-red-500/70"></span>
            <span className="w-2 h-2 rounded-full bg-yellow-500/70"></span>
            <span className="w-2 h-2 rounded-full bg-emerald-500/70"></span>
          </div>
          <span className="text-[10px] font-mono text-slate-400 flex items-center gap-1 ml-1.5">
            <TerminalIcon size={10} className="text-emerald-500" />
            {data.label || "Terminal Node"}
          </span>
        </div>
        <button className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-emerald-500 transition-colors">
          <Play size={10} />
        </button>
      </div>

      {/* Terminal Display */}
      <div className="p-2 bg-slate-950 font-mono text-xs">
        <div ref={terminalRef} className="w-full h-[120px] overflow-hidden" />
      </div>
    </div>
  );
}
