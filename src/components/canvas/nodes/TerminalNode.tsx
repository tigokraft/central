import { useEffect, useRef, useState } from "react";
import { useDrag } from "@use-gesture/react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon, type ISearchResultChangeEvent } from "@xterm/addon-search";
import {
  Terminal as TerminalIcon,
  Play,
  GitCompare,
  Brain,
  Eraser,
  ChevronUp,
  ChevronDown,
  X,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCanvasStore, CanvasNode, beginHistoryBatch, endHistoryBatch } from "../../../store/canvasStore";
import { viewportController } from "../../../lib/viewportController";
import Port from "../Port";

// Import xterm CSS styles so that it renders properly
import "@xterm/xterm/css/xterm.css";

interface TerminalNodeProps {
  node: CanvasNode;
}

interface AimemFactPayload {
  id: string;
  content: string;
  created_at: string;
}

// Turns arbitrary (possibly multi-line) fact text into inert shell comment lines, so
// prefixing a command with project context can never cause a partial line to execute.
function toCommentBlock(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `# [context] ${line}`)
    .join("\r");
}

// Collects context text from both live MemoryNode cables (attachedMemoryIds, resolved
// against current canvas state) and manually attached .aimem facts (attachedFacts).
function gatherContextFacts(nodeData: CanvasNode["data"]): string[] {
  const facts: string[] = [];
  const memoryIds = nodeData.attachedMemoryIds || [];
  if (memoryIds.length > 0) {
    const allNodes = useCanvasStore.getState().nodes;
    for (const memId of memoryIds) {
      const memNode = allNodes.find((n) => n.id === memId);
      if (memNode?.data.facts) facts.push(...memNode.data.facts);
    }
  }
  for (const fact of nodeData.attachedFacts || []) {
    facts.push(fact.content);
  }
  return facts;
}

// In "memory-aware" mode, auto-prefixes a command with its attached project context as
// harmless shell comments. Isolated nodes (the default) run the command as-is.
function buildCommandWithContext(command: string, nodeData: CanvasNode["data"]): string {
  if (nodeData.contextMode !== "memory-aware") return command;
  const facts = gatherContextFacts(nodeData);
  if (facts.length === 0) return command;
  return `${facts.map(toCommentBlock).join("\r")}\r${command}`;
}

// Collapsed height of a minimized terminal card: just tall enough for the title bar.
const MINIMIZED_HEIGHT = 36;

export default function TerminalNode({ node }: TerminalNodeProps) {
  const { id, data } = node;
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const updateNodeDimensions = useCanvasStore((state) => state.updateNodeDimensions);

  const terminalRef = useRef<HTMLDivElement>(null);
  const termInstance = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  // True once spawn_pty resolves, so a resize triggered before the PTY exists doesn't
  // invoke resize_pty against a session that isn't registered yet.
  const ptyReadyRef = useRef(false);
  const [ptyStatus, setPtyStatus] = useState<"idle" | "running" | "error">("idle");
  // Remembers the expanded height so restoring from minimized doesn't have to guess it.
  const preMinimizeHeightRef = useRef(node.height);

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
      convertEol: true, // convert \n to \r\n
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);
    fitAddon.fit();

    termInstance.current = term;
    fitAddonRef.current = fitAddon;

    // Send local keystrokes directly to the PTY
    const onDataDisposable = term.onData((input) => {
      setPtyStatus("running");
      updateNodeData(id, { status: "running" });
      invoke("write_pty", { nodeId: id, data: input }).catch((err) => {
        console.error(err);
        setPtyStatus("error");
        updateNodeData(id, { status: "error" });
      });
    });

    let unlistenOutput: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;

    const setupPty = async () => {
      try {
        const cols = term.cols || 40;
        const rows = term.rows || 8;

        // Subscribe to PTY output stream
        unlistenOutput = await listen<{ node_id: string; data: string }>(
          "pty-output",
          (event) => {
            if (event.payload.node_id === id) {
              term.write(event.payload.data);
            }
          }
        );

        // Subscribe to PTY exit notification
        unlistenExit = await listen<{ node_id: string }>(
          "pty-exit",
          (event) => {
            if (event.payload.node_id === id) {
              term.writeln("\r\n\x1b[31m[Process Exited]\x1b[0m");
              setPtyStatus("idle");
              updateNodeData(id, { isRunning: false, status: "idle" });
            }
          }
        );

        // Spawn interactive shell
        await invoke("spawn_pty", { nodeId: id, cols, rows });
        ptyReadyRef.current = true;
        setPtyStatus("idle");
        updateNodeData(id, { status: "idle" });
      } catch (err) {
        console.error("Failed to initialize PTY:", err);
        term.writeln(`\r\n\x1b[31m[Error] Failed to initialize PTY: ${err}\x1b[0m`);
        setPtyStatus("error");
        updateNodeData(id, { status: "error" });
      }
    };

    setupPty();

    return () => {
      ptyReadyRef.current = false;
      onDataDisposable.dispose();
      if (unlistenOutput) unlistenOutput();
      if (unlistenExit) unlistenExit();
      invoke("destroy_pty", { nodeId: id }).catch(console.error);
      term.dispose();
    };
  }, [id, updateNodeData]);

  // Re-fits the terminal's rows/cols to the card's current size (manual resize, minimize,
  // or restore) and lets the backend PTY know so the shell's own notion of its window size
  // stays in sync. Skipped while minimized, since the display is hidden and its size is
  // meaningless until it's restored.
  useEffect(() => {
    if (data.minimized) return;
    const fitAddon = fitAddonRef.current;
    const term = termInstance.current;
    if (!fitAddon || !term) return;

    // Defer one frame so the wrapper's new inline height/width has already been painted.
    const raf = requestAnimationFrame(() => {
      fitAddon.fit();
      if (ptyReadyRef.current) {
        invoke("resize_pty", { nodeId: id, cols: term.cols, rows: term.rows }).catch(console.error);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [id, node.width, node.height, data.minimized]);

  // Sync execution triggers from canvasState
  useEffect(() => {
    if (data.isRunning && data.command) {
      setPtyStatus("running");
      const finalCommand = buildCommandWithContext(data.command, data);
      invoke("write_pty", { nodeId: id, data: finalCommand + "\r" }).catch((err) => {
        console.error(err);
        setPtyStatus("error");
        updateNodeData(id, { status: "error" });
      });
    }
  }, [id, data.isRunning, data.command, updateNodeData]);

  const handleRunCommand = () => {
    if (data.command) {
      const finalCommand = buildCommandWithContext(data.command, data);
      setPtyStatus("running");
      updateNodeData(id, { isRunning: true, status: "running" });
      invoke("write_pty", { nodeId: id, data: finalCommand + "\r" }).catch((err) => {
        console.error(err);
        setPtyStatus("error");
        updateNodeData(id, { status: "error" });
      });
    }
  };

  const handleToggleContextMode = () => {
    beginHistoryBatch();
    updateNodeData(id, {
      contextMode: data.contextMode === "memory-aware" ? "isolated" : "memory-aware",
    });
    endHistoryBatch();
  };

  // Reads the working tree diff over Tauri IPC and pastes it into the terminal's stdin via
  // xterm's bracketed-paste-aware paste(), so readline-based CLIs (Claude Code, Gemini CLI,
  // Codex) receive it as one block instead of executing each line as it streams in.
  const handleInjectGitDiff = async () => {
    try {
      const diff = await invoke<string>("get_git_diff");
      if (!diff.trim()) {
        termInstance.current?.writeln("\r\n\x1b[33m[No pending changes to inject]\x1b[0m");
        return;
      }
      termInstance.current?.paste(diff);
    } catch (err) {
      console.error("Failed to inject git diff:", err);
      termInstance.current?.writeln(`\r\n\x1b[31m[Error] Failed to read git diff: ${err}\x1b[0m`);
    }
  };

  // Attaches the most recently created .aimem fact on disk to this node so it contributes
  // to the memory-aware command prefix, mirroring what a MemoryNode cable would attach.
  const handleAttachFact = async () => {
    try {
      const facts = await invoke<AimemFactPayload[]>("list_aimem_facts");
      if (facts.length === 0) {
        termInstance.current?.writeln("\r\n\x1b[33m[No .aimem facts found on disk]\x1b[0m");
        return;
      }
      const [latest] = facts;
      const existing = data.attachedFacts || [];
      if (existing.some((f) => f.id === latest.id)) return;
      beginHistoryBatch();
      updateNodeData(id, {
        attachedFacts: [...existing, { id: latest.id, content: latest.content }],
      });
      endHistoryBatch();
    } catch (err) {
      console.error("Failed to attach .aimem fact:", err);
    }
  };

  const handleClearHistory = () => {
    termInstance.current?.clear();
  };

  const handleToggleMinimize = () => {
    beginHistoryBatch();
    if (data.minimized) {
      updateNodeDimensions(id, node.width, preMinimizeHeightRef.current || 190);
      updateNodeData(id, { minimized: false });
    } else {
      preMinimizeHeightRef.current = node.height;
      updateNodeDimensions(id, node.width, MINIMIZED_HEIGHT);
      updateNodeData(id, { minimized: true });
    }
    endHistoryBatch();
  };

  // Bottom-right corner drag handle, matching ActionContainerNode's resize affordance.
  const bindResize = useDrag(
    ({ delta: [dx, dy], first, last, event }) => {
      event.stopPropagation();
      if (first) beginHistoryBatch();
      const zoom = viewportController.getViewport().zoom;
      const nextWidth = Math.max(240, node.width + dx / zoom);
      const nextHeight = Math.max(120, node.height + dy / zoom);
      updateNodeDimensions(id, nextWidth, nextHeight);
      if (last) endHistoryBatch();
    },
    {
      pointer: { capture: false },
    }
  );

  // Compute status light configuration
  let statusColor = "bg-yellow-500";
  let statusText = "Idle";
  if (data.isRunning || ptyStatus === "running") {
    statusColor = "bg-emerald-500 animate-pulse";
    statusText = "Running";
  } else if (data.status === "error" || ptyStatus === "error") {
    statusColor = "bg-red-500";
    statusText = "Error";
  } else if (data.status === "success") {
    statusColor = "bg-emerald-500";
    statusText = "Success";
  }

  return (
    <div className="relative w-full h-full bg-slate-900 border border-slate-800 rounded-lg shadow-panel overflow-hidden flex flex-col transition-colors hover:border-emerald-500/50 select-none">
      {/* Sockets - Top and Bottom handles for TerminalNode */}
      <Port
        nodeId={id}
        handleId="trigger"
        type="target"
        className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2"
      />
      <Port
        nodeId={id}
        handleId="done"
        type="source"
        className="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2"
      />
      {/* Dedicated socket for MemoryNode context cables */}
      <Port
        nodeId={id}
        handleId="context"
        type="target"
        color="neutral"
        className="absolute -left-1.5 top-1/2 -translate-y-1/2"
      />

      {/* Terminal Title Bar */}
      <div className="bg-slate-950 px-3 py-2 flex items-center justify-between border-b border-slate-800 shrink-0">
        <div className="flex items-center gap-2">
          {/* Window Control Dots */}
          <div className="flex gap-1 shrink-0">
            <span className="w-2 h-2 rounded-full bg-red-500/70"></span>
            <span className="w-2 h-2 rounded-full bg-yellow-500/70"></span>
            <span className="w-2 h-2 rounded-full bg-emerald-500/70"></span>
          </div>
          <span className="text-[10px] font-mono text-slate-400 flex items-center gap-1 ml-1.5 truncate">
            <TerminalIcon size={10} className="text-emerald-500 shrink-0" />
            {data.label || "Terminal Node"}
          </span>
          {/* Status Light */}
          <div className="flex items-center gap-1.5 ml-2 px-1.5 py-0.5 rounded bg-slate-900 border border-slate-800 shrink-0">
            <span className={`w-1.5 h-1.5 rounded-full ${statusColor}`} />
            <span className="text-[8px] font-mono text-slate-500 uppercase">{statusText}</span>
          </div>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={handleRunCommand}
            className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-emerald-500 transition-colors cursor-pointer"
          >
            <Play size={10} />
          </button>
          <button
            onClick={handleToggleMinimize}
            title={data.minimized ? "Restore" : "Minimize"}
            className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
          >
            {data.minimized ? <ChevronDown size={10} /> : <ChevronUp size={10} />}
          </button>
        </div>
      </div>

      {!data.minimized && (
        <>
          {/* Context Injection HUD */}
          <div className="bg-slate-950/60 px-2 py-1 flex items-center justify-between gap-1.5 border-b border-slate-800/80 shrink-0">
            <button
              onClick={handleToggleContextMode}
              title="Toggle context isolation"
              className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[8px] font-mono border transition-colors cursor-pointer shrink-0 ${
                data.contextMode === "memory-aware"
                  ? "bg-emerald-500/10 border-emerald-500/40 text-emerald-300"
                  : "bg-slate-900 border-slate-800 text-slate-500"
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  data.contextMode === "memory-aware" ? "bg-emerald-400" : "bg-slate-600"
                }`}
              />
              Context: {data.contextMode === "memory-aware" ? "Memory-Aware" : "Isolated"}
            </button>
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={handleInjectGitDiff}
                title="Inject Git Diff"
                className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-emerald-400 transition-colors cursor-pointer"
              >
                <GitCompare size={10} />
              </button>
              <button
                onClick={handleAttachFact}
                title="Attach .aimem Fact"
                className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-emerald-400 transition-colors cursor-pointer"
              >
                <Brain size={10} />
              </button>
              <button
                onClick={handleClearHistory}
                title="Clear History"
                className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-red-400 transition-colors cursor-pointer"
              >
                <Eraser size={10} />
              </button>
            </div>
          </div>
        </>
      )}

      {/* Terminal Display - kept mounted while minimized (just hidden) so the live xterm
          instance and its PTY subscription never have to be torn down and rebuilt. */}
      <div
        className="p-2 bg-slate-950 font-mono text-xs flex-1 min-h-0"
        style={data.minimized ? { display: "none" } : undefined}
      >
        <div ref={terminalRef} className="w-full h-full overflow-hidden" data-nodrag />
      </div>

      {/* Resize Handle */}
      {!data.minimized && (
        <div
          className="absolute bottom-0 right-0 w-3.5 h-3.5 cursor-se-resize resize-handle flex items-end justify-end p-0.5 z-40"
          {...(bindResize() as any)}
        >
          <svg width="8" height="8" viewBox="0 0 8 8" className="text-slate-500 hover:text-emerald-400">
            <line x1="6" y1="0" x2="6" y2="8" stroke="currentColor" strokeWidth="1" />
            <line x1="0" y1="6" x2="8" y2="6" stroke="currentColor" strokeWidth="1" />
          </svg>
        </div>
      )}
    </div>
  );
}
