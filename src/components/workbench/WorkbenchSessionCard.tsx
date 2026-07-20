import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Terminal as TerminalIcon,
  Play,
  Eye,
  EyeOff,
  Maximize2,
  Minimize2,
  GitBranch,
  ArrowUpToLine,
  Trash2,
  Pencil,
} from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import { useWorkbenchStore, type WorkbenchSession } from "../../store/workbenchStore";
import { useAgentSessionStore, type AgentEvent } from "../../store/agentSessionStore";
import { useSettingsStore } from "../../store/settingsStore";
import { type AgentAvailability } from "../../lib/agents";
import { type PromoteResult, bindingLabel } from "../../lib/workbench";
import Button from "../ui/Button";
import Modal from "../ui/Modal";
import BindingPicker from "./BindingPicker";

const DEFAULT_PTY_COLS = 100;
const DEFAULT_PTY_ROWS = 30;
const QUIET_TAIL_RAW_CHAR_CAP = 4000;
const QUIET_TAIL_LINE_COUNT = 3;

function stripAnsiCodes(text: string): string {
  return text
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b[()][A-Za-z0-9]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

function lastNonEmptyLines(text: string, count: number): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-count);
}

function agentBadgeText(event: AgentEvent): string {
  switch (event.type) {
    case "Started":
      return "Agent Running";
    case "ToolCall":
      return `Agent: ${event.name}`;
    case "FileEdited":
      return "Agent Editing";
    case "NeedsInput":
      return "Needs Input";
    case "Done":
      return `Agent Done (${event.exit_code})`;
    case "Raw":
      return "Agent Running";
  }
}

function agentBadgeColor(event: AgentEvent): string {
  switch (event.type) {
    case "NeedsInput":
      return "bg-amber-500 animate-pulse";
    case "Done":
      return event.exit_code === 0 ? "bg-emerald-500" : "bg-red-500";
    default:
      return "bg-emerald-500 animate-pulse";
  }
}

interface WorkbenchSessionCardProps {
  session: WorkbenchSession;
  projectId: string;
  agents: AgentAvailability[];
  isFocused: boolean;
}

export default function WorkbenchSessionCard({ session, projectId, agents, isFocused }: WorkbenchSessionCardProps) {
  const updateSession = useWorkbenchStore((s) => s.updateSession);
  const updateBinding = useWorkbenchStore((s) => s.updateBinding);
  const removeSession = useWorkbenchStore((s) => s.removeSession);
  const setFocusedSessionId = useWorkbenchStore((s) => s.setFocusedSessionId);
  const agentEvent = useAgentSessionStore((state) => state.eventsByNode[session.id]);
  const fontSize = useSettingsStore((s) => s.defaultTerminalFontSize);

  const [displayMode, setDisplayMode] = useState<"quiet" | "live">("quiet");
  const [ptyStatus, setPtyStatus] = useState<"idle" | "running" | "error">("idle");
  const [quietTailLines, setQuietTailLines] = useState<string[]>([]);
  const [lastSubmittedCommand, setLastSubmittedCommand] = useState<string | undefined>(undefined);
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelDraft, setLabelDraft] = useState(session.label);
  const [prompt, setPrompt] = useState("");
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(session.agentId);
  const [showBindingPicker, setShowBindingPicker] = useState(false);
  const [showDiscard, setShowDiscard] = useState(false);
  const [promoteState, setPromoteState] = useState<
    { diff: string; error: string | null; busy: boolean } | null
  >(null);

  const terminalRef = useRef<HTMLDivElement>(null);
  const termInstance = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const ptyReadyRef = useRef(false);
  const outputSinkRef = useRef<(chunk: string) => void>(() => {});
  const quietTailBufferRef = useRef("");

  // The card's content (PTY subscriptions, xterm view) always renders into this single
  // detached div, physically reparented (plain DOM appendChild, outside React) between the
  // grid anchor and document.body as focus toggles — mirroring TerminalNode's canvas focus
  // mode. This is what lets expand/collapse happen without tearing down (and re-spawning) the
  // session's PTY or xterm instance; rendering two separate card instances for the same
  // session (one in the grid, one in an overlay) would each spawn their own PTY for the same
  // node id and stomp on each other.
  const portalHostRef = useRef<HTMLDivElement | null>(null);
  if (!portalHostRef.current) {
    portalHostRef.current = document.createElement("div");
  }
  const anchorRef = useRef<HTMLDivElement>(null);

  const isBusy = ptyStatus === "running" || (!!agentEvent && agentEvent.type !== "Done");
  const xtermMounted = displayMode === "live";

  useEffect(() => {
    const host = portalHostRef.current;
    if (!host) return;
    if (isFocused) {
      host.className = "fixed inset-8 z-50";
      document.body.appendChild(host);
    } else {
      host.className = "w-full h-full";
      anchorRef.current?.appendChild(host);
    }
  }, [isFocused]);

  useEffect(() => {
    return () => {
      portalHostRef.current?.remove();
    };
  }, []);

  // PTY session lifecycle: spawned in the session's bound cwd, torn down and respawned
  // whenever the binding (and therefore the cwd) changes.
  useEffect(() => {
    if (!session.cwd) return;
    let cancelled = false;
    let unlistenOutput: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;
    let unlistenAgentEvent: (() => void) | null = null;

    const setupPty = async () => {
      try {
        const offOutput = await listen<{ node_id: string; data: string }>("pty-output", (event) => {
          if (event.payload.node_id !== session.id) return;
          const chunk = event.payload.data;
          quietTailBufferRef.current = (quietTailBufferRef.current + chunk).slice(-QUIET_TAIL_RAW_CHAR_CAP);
          setQuietTailLines(lastNonEmptyLines(stripAnsiCodes(quietTailBufferRef.current), QUIET_TAIL_LINE_COUNT));
          outputSinkRef.current(chunk);
        });
        if (cancelled) {
          offOutput();
          return;
        }
        unlistenOutput = offOutput;

        const offExit = await listen<{ node_id: string }>("pty-exit", (event) => {
          if (event.payload.node_id === session.id) {
            termInstance.current?.writeln("\r\n\x1b[31m[Process Exited]\x1b[0m");
            setPtyStatus("idle");
          }
        });
        if (cancelled) {
          offExit();
          return;
        }
        unlistenExit = offExit;

        const offAgentEvent = await listen<{ node_id: string; event: AgentEvent }>("agent-event", (event) => {
          if (event.payload.node_id === session.id) {
            useAgentSessionStore.getState().setEvent(session.id, event.payload.event);
          }
        });
        if (cancelled) {
          offAgentEvent();
          return;
        }
        unlistenAgentEvent = offAgentEvent;

        await invoke("spawn_pty", {
          nodeId: session.id,
          cols: DEFAULT_PTY_COLS,
          rows: DEFAULT_PTY_ROWS,
          cwd: session.cwd,
        });
        if (cancelled) return;
        ptyReadyRef.current = true;
        setPtyStatus("idle");
      } catch (err) {
        if (cancelled) return;
        console.error("Failed to initialize workbench PTY:", err);
        setPtyStatus("error");
      }
    };

    setupPty();

    return () => {
      cancelled = true;
      ptyReadyRef.current = false;
      if (unlistenOutput) unlistenOutput();
      if (unlistenExit) unlistenExit();
      if (unlistenAgentEvent) unlistenAgentEvent();
      useAgentSessionStore.getState().clearEvent(session.id);
      invoke("destroy_pty", { nodeId: session.id }).catch(() => {});
    };
  }, [session.id, session.cwd]);

  // xterm instantiation: only while live, mirroring TerminalNode's quiet/live split so a dozen
  // idle session cards never carry a dozen live terminal emulator instances.
  useEffect(() => {
    if (!xtermMounted || !terminalRef.current) return;

    const term = new Terminal({
      theme: {
        background: "#020617",
        foreground: "#10b981",
        cursor: "#10b981",
        selectionBackground: "rgba(16, 185, 129, 0.3)",
      },
      fontSize,
      lineHeight: 1.1,
      fontFamily: "Fira Code, ui-monospace, monospace",
      cursorBlink: true,
      convertEol: true,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);
    fitAddon.fit();
    termInstance.current = term;
    fitAddonRef.current = fitAddon;

    const onDataDisposable = term.onData((input) => {
      setPtyStatus("running");
      invoke("write_pty", { nodeId: session.id, data: input }).catch((err) => {
        console.error(err);
        setPtyStatus("error");
      });
    });

    let cancelled = false;
    const queued: string[] = [];
    outputSinkRef.current = (chunk) => queued.push(chunk);
    const flushQueueAndGoLive = () => {
      if (cancelled) return;
      for (const chunk of queued) term.write(chunk);
      queued.length = 0;
      outputSinkRef.current = (chunk) => term.write(chunk);
    };
    invoke<string>("get_pty_scrollback", { nodeId: session.id })
      .then((backlog) => {
        if (cancelled) return;
        if (backlog) term.write(backlog);
        flushQueueAndGoLive();
      })
      .catch(() => flushQueueAndGoLive());

    return () => {
      cancelled = true;
      outputSinkRef.current = () => {};
      onDataDisposable.dispose();
      term.dispose();
      termInstance.current = null;
      fitAddonRef.current = null;
    };
  }, [session.id, xtermMounted, fontSize]);

  // Re-fits on card resize (focus toggle changes the card's footprint dramatically).
  useEffect(() => {
    if (displayMode !== "live") return;
    const fitAddon = fitAddonRef.current;
    const term = termInstance.current;
    if (!fitAddon || !term) return;
    const raf = requestAnimationFrame(() => {
      fitAddon.fit();
      if (ptyReadyRef.current) {
        invoke("resize_pty", { nodeId: session.id, cols: term.cols, rows: term.rows }).catch(console.error);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [session.id, displayMode, isFocused]);

  const commitLabel = () => {
    setEditingLabel(false);
    const trimmed = labelDraft.trim();
    if (trimmed && trimmed !== session.label) updateSession(session.id, { label: trimmed });
    else setLabelDraft(session.label);
  };

  const handleLaunchAgent = async () => {
    if (!selectedAgentId || !prompt.trim() || !session.cwd) return;
    if (session.agentId !== selectedAgentId) updateSession(session.id, { agentId: selectedAgentId });
    setLastSubmittedCommand(`[${selectedAgentId}] ${prompt.trim()}`);
    try {
      await invoke("launch_agent_session", {
        request: {
          nodeId: session.id,
          adapterId: selectedAgentId,
          prompt: prompt.trim(),
          cwd: session.cwd,
          options: null,
        },
      });
      setPrompt("");
    } catch (err) {
      console.error("Failed to launch agent session:", err);
    }
  };

  const openPromote = async () => {
    if (session.binding.kind === "main") return;
    try {
      const diff = await invoke<string>("get_branch_diff", { projectId, branch: session.binding.branch });
      setPromoteState({ diff, error: null, busy: false });
    } catch (err) {
      setPromoteState({ diff: "", error: String(err), busy: false });
    }
  };

  const confirmPromote = async () => {
    setPromoteState((s) => (s ? { ...s, busy: true, error: null } : s));
    try {
      const result = await invoke<PromoteResult>("promote_workbench_session", {
        projectId,
        sessionId: session.id,
      });
      void result;
      setPromoteState(null);
    } catch (err) {
      setPromoteState((s) => (s ? { ...s, busy: false, error: String(err) } : s));
    }
  };

  const confirmDiscard = async () => {
    setShowDiscard(false);
    await removeSession(session.id);
  };

  let statusColor = "bg-yellow-500";
  let statusText = "Idle";
  if (ptyStatus === "running") {
    statusColor = "bg-emerald-500 animate-pulse";
    statusText = "Running";
  } else if (ptyStatus === "error") {
    statusColor = "bg-red-500";
    statusText = "Error";
  }

  const card = (
    <div className="relative w-full h-full bg-slate-900 border border-slate-800 rounded-lg shadow-panel overflow-hidden flex flex-col select-none">
      {/* Header */}
      <div className="bg-slate-950 px-3 py-2 flex items-center justify-between border-b border-slate-800 shrink-0 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <TerminalIcon size={12} className="text-emerald-500 shrink-0" />
          {editingLabel ? (
            <input
              autoFocus
              value={labelDraft}
              onChange={(e) => setLabelDraft(e.target.value)}
              onBlur={commitLabel}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitLabel();
                if (e.key === "Escape") {
                  setLabelDraft(session.label);
                  setEditingLabel(false);
                }
              }}
              className="bg-slate-900 border border-emerald-500/50 rounded px-1 py-0.5 text-xs text-slate-100 w-32 focus:outline-none"
            />
          ) : (
            <button
              onClick={() => setEditingLabel(true)}
              className="flex items-center gap-1 text-xs font-medium text-slate-200 truncate hover:text-emerald-400 cursor-pointer"
              title="Rename session"
            >
              {session.label}
              <Pencil size={9} className="text-slate-600 shrink-0" />
            </button>
          )}
          <div className="flex items-center gap-1.5 px-1.5 py-0.5 rounded bg-slate-900 border border-slate-800 shrink-0">
            <span className={`w-1.5 h-1.5 rounded-full ${statusColor}`} />
            <span className="text-[8px] font-mono text-slate-500 uppercase">{statusText}</span>
          </div>
          {agentEvent && (
            <div className="flex items-center gap-1.5 px-1.5 py-0.5 rounded bg-slate-900 border border-slate-800 shrink-0">
              <span className={`w-1.5 h-1.5 rounded-full ${agentBadgeColor(agentEvent)}`} />
              <span className="text-[8px] font-mono text-slate-500 uppercase truncate max-w-[100px]">
                {agentBadgeText(agentEvent)}
              </span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={() => setDisplayMode(displayMode === "quiet" ? "live" : "quiet")}
            title={displayMode === "quiet" ? "Take over (live)" : "Back to quiet"}
            className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
          >
            {displayMode === "quiet" ? <Eye size={11} /> : <EyeOff size={11} />}
          </button>
          <button
            onClick={() => setFocusedSessionId(isFocused ? null : session.id)}
            title={isFocused ? "Exit focus" : "Focus"}
            className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-emerald-400 transition-colors cursor-pointer"
          >
            {isFocused ? <Minimize2 size={11} /> : <Maximize2 size={11} />}
          </button>
        </div>
      </div>

      {/* Git binding + actions bar */}
      <div className="bg-slate-950/60 px-2 py-1 flex items-center justify-between gap-1.5 border-b border-slate-800/80 shrink-0">
        <button
          onClick={() => !isBusy && setShowBindingPicker(true)}
          disabled={isBusy}
          title={isBusy ? "Binding is locked while the session is busy" : "Change git binding"}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[8px] font-mono border bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed truncate max-w-[45%]"
        >
          <GitBranch size={9} className="shrink-0" />
          <span className="truncate">{bindingLabel(session.binding)}</span>
        </button>
        <div className="flex items-center gap-1 shrink-0">
          {session.binding.kind !== "main" && (
            <button
              onClick={() => void openPromote()}
              disabled={isBusy}
              title="Promote to main"
              className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-emerald-400 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ArrowUpToLine size={11} />
            </button>
          )}
          <button
            onClick={() => !isBusy && setShowDiscard(true)}
            disabled={isBusy}
            title="Discard session"
            className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-red-400 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Trash2 size={11} />
          </button>
        </div>
      </div>

      {/* Agent launcher */}
      <div className="px-2 py-1.5 flex items-center gap-1.5 border-b border-slate-800/80 shrink-0">
        <select
          value={selectedAgentId ?? ""}
          onChange={(e) => setSelectedAgentId(e.target.value || null)}
          className="bg-slate-900 border border-slate-800 rounded px-1.5 py-1 text-[10px] text-slate-300 focus:outline-none focus:border-emerald-500/50 shrink-0"
        >
          <option value="">Agent…</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id} disabled={!a.available}>
              {a.display_name} {a.available ? "" : "(unavailable)"}
            </option>
          ))}
        </select>
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleLaunchAgent();
          }}
          placeholder="Prompt…"
          className="flex-1 min-w-0 bg-slate-900 border border-slate-800 rounded px-1.5 py-1 text-[10px] text-slate-300 placeholder:text-slate-600 focus:outline-none focus:border-emerald-500/50"
        />
        <button
          onClick={() => void handleLaunchAgent()}
          disabled={!selectedAgentId || !prompt.trim()}
          title="Run headless"
          className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-emerald-400 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
        >
          <Play size={11} />
        </button>
      </div>

      {/* Body */}
      {displayMode === "live" ? (
        <div className="p-2 bg-slate-950 font-mono text-xs flex-1 min-h-0">
          <div ref={terminalRef} className="w-full h-full overflow-hidden" data-nodrag />
        </div>
      ) : (
        <div className="p-2 bg-slate-950 font-mono text-[10px] text-slate-400 flex-1 min-h-0 flex flex-col gap-1 overflow-hidden">
          <div className="flex items-center gap-1.5 text-slate-300 shrink-0 min-w-0">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusColor}`} />
            <span className="truncate">{lastSubmittedCommand ? lastSubmittedCommand : "No command run yet"}</span>
          </div>
          <div className="flex-1 min-h-0 overflow-hidden leading-tight">
            {quietTailLines.length > 0 ? (
              quietTailLines.map((line, i) => (
                <div key={i} className="truncate text-slate-500">
                  {line}
                </div>
              ))
            ) : (
              <div className="italic text-slate-600">No output yet</div>
            )}
          </div>
        </div>
      )}

      {showBindingPicker && (
        <BindingPicker
          projectId={projectId}
          initial={session.binding}
          onCancel={() => setShowBindingPicker(false)}
          onConfirm={async (binding) => {
            setShowBindingPicker(false);
            await updateBinding(session.id, binding);
          }}
        />
      )}

      {showDiscard && (
        <Modal onClose={() => setShowDiscard(false)} width={360}>
          <p className="text-xs font-semibold text-slate-200 uppercase tracking-wide">Discard Session</p>
          <p className="text-xs text-slate-400 mt-2">
            Discard <span className="text-slate-200 font-medium">{session.label}</span>?
            {session.binding.kind === "new" && " Its branch and worktree will be deleted."}
            {session.binding.kind === "existing" && " Its worktree will be removed (the branch itself is kept)."}
            {" "}
            This cannot be undone.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setShowDiscard(false)}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={() => void confirmDiscard()} className="bg-red-500 hover:bg-red-400 text-slate-950">
              Discard
            </Button>
          </div>
        </Modal>
      )}

      {promoteState && (
        <Modal onClose={() => setPromoteState(null)} width={560}>
          <p className="text-xs font-semibold text-slate-200 uppercase tracking-wide">
            Promote {session.binding.kind !== "main" ? session.binding.branch : ""} into main
          </p>
          {promoteState.error && (
            <p className="text-xs text-red-400 mt-2 whitespace-pre-wrap">{promoteState.error}</p>
          )}
          <pre className="mt-3 max-h-80 overflow-auto bg-slate-950 border border-slate-800 rounded p-2 text-[10px] text-slate-300 font-mono whitespace-pre-wrap">
            {promoteState.diff || "No changes."}
          </pre>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setPromoteState(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={promoteState.busy || !promoteState.diff}
              onClick={() => void confirmPromote()}
            >
              {promoteState.busy ? "Merging…" : "Confirm Merge"}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );

  return (
    <>
      {/* Occupies the card's normal grid slot. The portal host below is appended as its
          child while unfocused, and moved out to document.body while focused. */}
      <div ref={anchorRef} className="w-full h-full" />
      {createPortal(
        <>
          {isFocused && (
            <div
              className="absolute inset-0 bg-slate-950/70 backdrop-blur-sm"
              onClick={() => setFocusedSessionId(null)}
            />
          )}
          {card}
        </>,
        portalHostRef.current
      )}
    </>
  );
}
