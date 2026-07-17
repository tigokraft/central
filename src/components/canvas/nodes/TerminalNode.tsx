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

// Unique id generator for terminalRunHistory entries — a node produces many lines over its
// lifetime (unlike ephemeral runs, which get one archive entry each), so entries key off a
// running sequence rather than just a timestamp to stay collision-free within the same ms.
let historyEntrySeq = 0;
function nextHistoryEntryId(nodeId: string): string {
  historyEntrySeq += 1;
  return `${nodeId}-hist-${historyEntrySeq}`;
}

// Feeds raw PTY input (individual keystrokes, pastes, or escape sequences from arrow/nav
// keys) through a per-node line buffer and returns any lines completed (Enter pressed) by
// this chunk. Deliberately not a full shell line-editor — CSI escape sequences (arrows,
// home/end, etc.) are recognized just enough to be skipped rather than appended as garbage
// characters, but this stays a simple "line submitted at time T" log, nothing more.
function extractSubmittedLines(input: string, bufferRef: { current: string }): string[] {
  const lines: string[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === "\x1b") {
      // Skip CSI (ESC [ ... final-byte) / SS3 (ESC O <byte>) sequences, or a lone ESC.
      i++;
      if (input[i] === "[" || input[i] === "O") {
        i++;
        while (i < input.length && !/[A-Za-z~]/.test(input[i])) i++;
        i++;
      }
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      lines.push(bufferRef.current);
      bufferRef.current = "";
      i++;
      continue;
    }
    if (ch === "\x7f" || ch === "\b") {
      bufferRef.current = bufferRef.current.slice(0, -1);
      i++;
      continue;
    }
    if (ch.charCodeAt(0) < 0x20 && ch !== "\t") {
      i++;
      continue;
    }
    bufferRef.current += ch;
    i++;
  }
  return lines;
}

export default function TerminalNode({ node }: TerminalNodeProps) {
  const { id, data } = node;
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const updateNodeDimensions = useCanvasStore((state) => state.updateNodeDimensions);
  const logTerminalCommand = useCanvasStore((state) => state.logTerminalCommand);

  const terminalRef = useRef<HTMLDivElement>(null);
  const termInstance = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // True once spawn_pty resolves, so a resize triggered before the PTY exists doesn't
  // invoke resize_pty against a session that isn't registered yet.
  const ptyReadyRef = useRef(false);
  // Accumulates the current in-progress line typed by the user between Enter presses, so
  // history entries can be logged one full line at a time rather than per keystroke.
  const lineBufferRef = useRef("");
  const [ptyStatus, setPtyStatus] = useState<"idle" | "running" | "error">("idle");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResult, setSearchResult] = useState<ISearchResultChangeEvent | null>(null);
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

    const searchAddon = new SearchAddon();
    term.loadAddon(searchAddon);

    termInstance.current = term;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;

    const onSearchResultsDisposable = searchAddon.onDidChangeResults((event) => {
      setSearchResult(event);
    });

    // Intercepts Cmd/Ctrl+F before xterm's own key handling (and before it reaches the PTY),
    // scoped to this terminal instance since it only fires while its own textarea has focus.
    term.attachCustomKeyEventHandler((event) => {
      if (event.type === "keydown" && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setSearchOpen(true);
        return false;
      }
      return true;
    });

    // Send local keystrokes directly to the PTY, logging each completed line (Enter
    // pressed) to terminalRunHistory. Reads the node's current label from the store rather
    // than closing over `data` (fixed at mount time) so a later rename is reflected.
    const onDataDisposable = term.onData((input) => {
      setPtyStatus("running");
      updateNodeData(id, { status: "running" });
      for (const line of extractSubmittedLines(input, lineBufferRef)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const nodeLabel = useCanvasStore.getState().nodes.find((n) => n.id === id)?.data.label || "Terminal Console";
        logTerminalCommand({
          id: nextHistoryEntryId(id),
          nodeId: id,
          nodeLabel,
          command: trimmed,
          submittedAt: Date.now(),
        });
      }
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
      onSearchResultsDisposable.dispose();
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

  // Focuses the search input as soon as the search bar mounts.
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  // Sync execution triggers from canvasState. This is the single place that logs a
  // programmatic (Play button / cable-triggered) command to terminalRunHistory — it fires
  // exactly once per isRunning:false->true transition, regardless of what set isRunning,
  // so callers like handleRunCommand don't also need their own log call.
  useEffect(() => {
    if (data.isRunning && data.command) {
      setPtyStatus("running");
      const finalCommand = buildCommandWithContext(data.command, data);
      logTerminalCommand({
        id: nextHistoryEntryId(id),
        nodeId: id,
        nodeLabel: data.label || "Terminal Console",
        command: data.command,
        submittedAt: Date.now(),
      });
      invoke("write_pty", { nodeId: id, data: finalCommand + "\r" }).catch((err) => {
        console.error(err);
        setPtyStatus("error");
        updateNodeData(id, { status: "error" });
      });
    }
  }, [id, data.isRunning, data.command, data.label, updateNodeData, logTerminalCommand]);

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

  // Highlights every match while marking the current one, matching the terminal's emerald accent.
  const SEARCH_DECORATIONS = {
    matchBackground: "#78350f",
    matchBorder: "#f59e0b",
    matchOverviewRuler: "#f59e0b",
    activeMatchBackground: "#065f46",
    activeMatchBorder: "#10b981",
    activeMatchColorOverviewRuler: "#10b981",
  };

  const handleSearchQueryChange = (value: string) => {
    setSearchQuery(value);
    if (!value) {
      searchAddonRef.current?.clearDecorations();
      setSearchResult(null);
      return;
    }
    searchAddonRef.current?.findNext(value, { incremental: true, decorations: SEARCH_DECORATIONS });
  };

  const handleSearchNext = () => {
    if (!searchQuery) return;
    searchAddonRef.current?.findNext(searchQuery, { decorations: SEARCH_DECORATIONS });
  };

  const handleSearchPrevious = () => {
    if (!searchQuery) return;
    searchAddonRef.current?.findPrevious(searchQuery, { decorations: SEARCH_DECORATIONS });
  };

  const handleSearchClose = () => {
    searchAddonRef.current?.clearDecorations();
    setSearchOpen(false);
    setSearchQuery("");
    setSearchResult(null);
    termInstance.current?.focus();
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

      {!data.minimized && searchOpen && (
        <div className="bg-slate-950/80 px-2 py-1 flex items-center gap-1.5 border-b border-slate-800/80 shrink-0">
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => handleSearchQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (e.shiftKey) handleSearchPrevious();
                else handleSearchNext();
              } else if (e.key === "Escape") {
                e.preventDefault();
                handleSearchClose();
              }
            }}
            placeholder="Search terminal..."
            className="flex-1 min-w-0 bg-slate-900 border border-slate-800 rounded px-1.5 py-0.5 text-[10px] font-mono text-emerald-300 placeholder:text-slate-600 focus:outline-none focus:border-emerald-500/50"
          />
          <span className="text-[8px] font-mono text-slate-500 shrink-0 tabular-nums">
            {searchQuery
              ? searchResult && searchResult.resultCount > 0
                ? `${searchResult.resultIndex + 1}/${searchResult.resultCount}`
                : "0/0"
              : ""}
          </span>
          <button
            onClick={handleSearchPrevious}
            title="Previous match (Shift+Enter)"
            className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-emerald-400 transition-colors cursor-pointer"
          >
            <ChevronUp size={10} />
          </button>
          <button
            onClick={handleSearchNext}
            title="Next match (Enter)"
            className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-emerald-400 transition-colors cursor-pointer"
          >
            <ChevronDown size={10} />
          </button>
          <button
            onClick={handleSearchClose}
            title="Close (Esc)"
            className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-red-400 transition-colors cursor-pointer"
          >
            <X size={10} />
          </button>
        </div>
      )}

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
