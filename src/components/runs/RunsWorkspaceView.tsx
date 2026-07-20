import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowLeft, CheckCircle2, Loader2 } from "lucide-react";
import Sidebar from "../Sidebar";
import ProjectViewSwitcher from "../ProjectViewSwitcher";
import Button from "../ui/Button";
import { useAppViewStore } from "../../store/appViewStore";
import { useRunStore, type Run, type RunStatus } from "../../store/runStore";
import RunTaskCard from "./RunTaskCard";

// Live view of the orchestrator's dispatcher/integrator engine (src-tauri/src/orchestration):
// every task in the active run as a card that updates off the "orchestration-event" stream, plus
// the human-gate confirmation step and the project's test-command setting. Launched from
// OrchestratorBar's "Orchestrate" mode, which switches into this view once a run starts.
export default function RunsWorkspaceView() {
  const goHome = useAppViewStore((state) => state.goHome);
  const activeProjectId = useAppViewStore((state) => state.activeProjectId);

  const runs = useRunStore((state) => state.runs);
  const runOrder = useRunStore((state) => state.runOrder);
  const activeRunId = useRunStore((state) => state.activeRunId);
  const setActiveRunId = useRunStore((state) => state.setActiveRunId);
  const confirmPromotion = useRunStore((state) => state.confirmPromotion);
  const ensureListener = useRunStore((state) => state.ensureListener);

  const [testCommand, setTestCommand] = useState("");
  const [savingTestCommand, setSavingTestCommand] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    ensureListener();
  }, [ensureListener]);

  const projectRunIds = useMemo(
    () => runOrder.filter((id) => runs[id]?.projectId === activeProjectId),
    [runOrder, runs, activeProjectId]
  );

  useEffect(() => {
    if (!activeProjectId) return;
    invoke<{ testCommand: string }>("get_orchestration_settings", { projectId: activeProjectId })
      .then((settings) => setTestCommand(settings.testCommand))
      .catch((err) => console.error("Failed to load orchestration settings:", err));
  }, [activeProjectId]);

  const saveTestCommand = async () => {
    if (!activeProjectId) return;
    setSavingTestCommand(true);
    try {
      await invoke("save_orchestration_settings", {
        projectId: activeProjectId,
        settings: { testCommand },
      });
    } catch (err) {
      console.error("Failed to save orchestration settings:", err);
    } finally {
      setSavingTestCommand(false);
    }
  };

  const handleConfirm = async (runId: string) => {
    setConfirming(true);
    try {
      await confirmPromotion(runId);
    } catch (err) {
      console.error("Failed to promote run to main:", err);
    } finally {
      setConfirming(false);
    }
  };

  if (!activeProjectId) return null;

  const activeRun = activeRunId ? runs[activeRunId] : undefined;
  const displayedRun = activeRun && activeRun.projectId === activeProjectId ? activeRun : undefined;

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

          <div className="flex items-center gap-2">
            {projectRunIds.length > 1 && (
              <select
                value={displayedRun?.runId ?? ""}
                onChange={(e) => setActiveRunId(e.target.value || null)}
                className="bg-slate-900 border border-slate-800 rounded-lg px-2 py-1.5 text-[10px] text-slate-300 font-mono focus:outline-none focus:border-emerald-500/50 cursor-pointer"
              >
                {projectRunIds.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>

        <div className="px-4 py-3 border-b border-slate-800/80 flex items-center gap-2 shrink-0">
          <label className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold shrink-0">
            Test command
          </label>
          <input
            type="text"
            value={testCommand}
            onChange={(e) => setTestCommand(e.target.value)}
            onBlur={saveTestCommand}
            placeholder="e.g. pnpm test (blank to skip)"
            className="flex-1 min-w-0 bg-slate-900 border border-slate-800 focus:border-emerald-500/60 rounded-lg px-3 py-1.5 text-xs text-slate-200 placeholder-slate-600 focus:outline-none font-mono transition-colors"
          />
          {savingTestCommand && <Loader2 size={12} className="animate-spin text-slate-500 shrink-0" />}
        </div>

        <div className="flex-1 overflow-auto p-4">
          {!displayedRun ? (
            <div className="h-full flex items-center justify-center text-sm text-slate-500 text-center px-8">
              No active run. Use the Orchestrator bar's "Orchestrate" mode from the Canvas view to launch a team of
              agents against a task list.
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3">
                <div className="flex items-center gap-3 text-xs text-slate-300">
                  <span className="font-mono text-slate-500">{displayedRun.runId}</span>
                  <RunStatusBadge run={displayedRun} />
                  {displayedRun.summary && (
                    <span className="text-slate-500">
                      {displayedRun.summary.done} done · {displayedRun.summary.failed} failed
                    </span>
                  )}
                </div>
                {displayedRun.status === "awaitingConfirmation" && (
                  <Button
                    variant="primary"
                    disabled={confirming}
                    onClick={() => handleConfirm(displayedRun.runId)}
                  >
                    {confirming ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
                    Promote staging to main
                  </Button>
                )}
                {displayedRun.status === "promoted" && (
                  <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-400">
                    <CheckCircle2 size={12} />
                    Promoted to main
                  </span>
                )}
              </div>

              <div
                className="grid gap-3"
                style={{ gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}
              >
                {displayedRun.order.map((taskId) => {
                  const status = displayedRun.tasks[taskId];
                  return status ? <RunTaskCard key={taskId} status={status} /> : null;
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function RunStatusBadge({ run }: { run: Run }) {
  const label: Record<RunStatus, string> = {
    running: "Running",
    awaitingConfirmation: "Awaiting confirmation",
    complete: "Complete",
    promoted: "Promoted",
    error: "Error",
  };
  return (
    <span className="px-2 py-0.5 rounded-full bg-slate-800 text-[10px] font-semibold uppercase tracking-wide text-slate-300">
      {label[run.status]}
    </span>
  );
}
