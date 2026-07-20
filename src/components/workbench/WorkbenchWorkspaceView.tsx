import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowLeft, Plus } from "lucide-react";
import Sidebar from "../Sidebar";
import ProjectViewSwitcher from "../ProjectViewSwitcher";
import { useAppViewStore } from "../../store/appViewStore";
import { useWorkbenchStore } from "../../store/workbenchStore";
import { type AgentAvailability } from "../../lib/agents";
import WorkbenchSessionCard from "./WorkbenchSessionCard";
import NewSessionModal from "./NewSessionModal";

export default function WorkbenchWorkspaceView() {
  const goHome = useAppViewStore((state) => state.goHome);
  const activeProjectId = useAppViewStore((state) => state.activeProjectId);
  const sessions = useWorkbenchStore((state) => state.sessions);
  const loading = useWorkbenchStore((state) => state.loading);
  const focusedSessionId = useWorkbenchStore((state) => state.focusedSessionId);
  const loadForProject = useWorkbenchStore((state) => state.loadForProject);
  const createSession = useWorkbenchStore((state) => state.createSession);
  const setFocusedSessionId = useWorkbenchStore((state) => state.setFocusedSessionId);

  const [agents, setAgents] = useState<AgentAvailability[]>([]);
  const [showNewSession, setShowNewSession] = useState(false);

  useEffect(() => {
    if (activeProjectId) void loadForProject(activeProjectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId]);

  useEffect(() => {
    invoke<AgentAvailability[]>("list_available_agents")
      .then(setAgents)
      .catch((err) => console.error("Failed to list available agents:", err));
  }, []);

  // Esc exits focus mode regardless of what currently has DOM focus, mirroring TerminalNode.
  useEffect(() => {
    if (!focusedSessionId) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFocusedSessionId(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [focusedSessionId, setFocusedSessionId]);

  if (!activeProjectId) return null;

  return (
    <div className="flex flex-1 overflow-hidden min-h-0">
      <Sidebar activeProcesses={[]} />
      <div className="flex-1 flex flex-col min-w-0 bg-slate-900 relative">
        <div className="h-14 bg-slate-950/90 backdrop-blur-md border-b border-slate-800/80 px-4 flex items-center justify-between select-none z-10 shrink-0">
          <button
            onClick={goHome}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-700 rounded-lg text-xs font-medium transition-all duration-200 cursor-pointer"
          >
            <ArrowLeft size={13} />
            Home
          </button>

          <ProjectViewSwitcher />

          <button
            onClick={() => setShowNewSession(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 rounded-lg text-xs font-semibold transition-all duration-200 cursor-pointer"
          >
            <Plus size={13} />
            New Session
          </button>
        </div>

        <div className="flex-1 overflow-auto p-4">
          {loading && sessions.length === 0 ? (
            <div className="text-xs text-slate-500 italic">Loading sessions…</div>
          ) : sessions.length === 0 ? (
            <div className="h-full flex items-center justify-center text-sm text-slate-500 text-center px-8">
              No sessions yet. Create one to run agents side by side, each pinned to its own branch.
            </div>
          ) : (
            <div
              className="grid gap-4"
              style={{ gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gridAutoRows: "320px" }}
            >
              {sessions.map((session) => (
                <WorkbenchSessionCard
                  key={session.id}
                  session={session}
                  projectId={activeProjectId}
                  agents={agents}
                  isFocused={focusedSessionId === session.id}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {showNewSession && (
        <NewSessionModal
          projectId={activeProjectId}
          agents={agents}
          defaultLabel={`Session ${sessions.length + 1}`}
          onClose={() => setShowNewSession(false)}
          onCreate={async (opts, binding) => {
            if (!binding) return;
            await createSession({ label: opts.label, agentId: opts.agentId, binding });
            setShowNewSession(false);
          }}
        />
      )}
    </div>
  );
}
