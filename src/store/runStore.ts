import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { OrchestratorTask } from "../lib/orchestrator/schema";
import type { AgentLaunchOptionsPayload } from "./orchestratorProfileStore";
import type { MergePolicy, OrchestrationEventPayload, TaskState } from "../lib/orchestrator/runEvents";

// Drives src-tauri/src/orchestration/run.rs's dispatcher+integrator: launches a task-list run,
// tracks every task's live state off the "orchestration-event" stream, and exposes the
// human-gate confirmation step. One store for the whole app (like agentSessionStore), since a
// run outlives whichever component happened to launch it.

export interface RunTaskStatus {
  task: OrchestratorTask;
  state: TaskState;
  retryCount: number;
  message: string | null;
}

export type RunStatus = "running" | "awaitingConfirmation" | "complete" | "promoted" | "error";

export interface Run {
  runId: string;
  projectId: string;
  mergePolicy: MergePolicy;
  tasks: Record<string, RunTaskStatus>;
  order: string[];
  status: RunStatus;
  summary: { done: number; failed: number } | null;
  error: string | null;
}

export interface StartRunOptions {
  projectId: string;
  tasks: OrchestratorTask[];
  adapterId: string;
  options: AgentLaunchOptionsPayload;
  maxParallel: number;
  retryLimit: number;
  mergePolicy: MergePolicy;
  testCommand: string;
}

interface RunState {
  runs: Record<string, Run>;
  runOrder: string[];
  activeRunId: string | null;
  listenerStarted: boolean;
  // Events for a runId this store doesn't know about yet, keyed by that runId. The backend
  // spawns its dispatcher (which starts emitting taskState events immediately) before
  // start_orchestration_run's own IPC reply necessarily reaches this store's `runs` map, so an
  // event can arrive before startRun has registered the run it belongs to. Buffered here instead
  // of dropped, then replayed once startRun creates the run entry.
  pendingEvents: Record<string, OrchestrationEventPayload["event"][]>;
  ensureListener: () => void;
  startRun: (opts: StartRunOptions) => Promise<string>;
  confirmPromotion: (runId: string) => Promise<void>;
  setActiveRunId: (runId: string | null) => void;
}

function applyEvent(run: Run, event: OrchestrationEventPayload["event"]): Run {
  switch (event.type) {
    case "taskState": {
      const existing = run.tasks[event.taskId];
      if (!existing) return run;
      return {
        ...run,
        tasks: {
          ...run.tasks,
          [event.taskId]: {
            ...existing,
            state: event.state,
            retryCount: event.retryCount,
            message: event.message,
          },
        },
      };
    }
    case "runComplete": {
      const status: RunStatus = event.awaitingConfirmation
        ? "awaitingConfirmation"
        : event.autoPromoted
          ? "promoted"
          : "complete";
      return { ...run, status, summary: { done: event.done, failed: event.failed } };
    }
    case "runFailed":
      return { ...run, status: "error", error: event.message };
    default:
      return run;
  }
}

export const useRunStore = create<RunState>((set, get) => ({
  runs: {},
  runOrder: [],
  activeRunId: null,
  listenerStarted: false,
  pendingEvents: {},

  ensureListener: () => {
    if (get().listenerStarted) return;
    set({ listenerStarted: true });
    void listen<OrchestrationEventPayload>("orchestration-event", (e) => {
      const { runId, event } = e.payload;
      set((state) => {
        const run = state.runs[runId];
        if (!run) {
          const buffered = state.pendingEvents[runId] ?? [];
          return { pendingEvents: { ...state.pendingEvents, [runId]: [...buffered, event] } };
        }
        return { runs: { ...state.runs, [runId]: applyEvent(run, event) } };
      });
    }).catch((err) => console.error("Failed to listen for orchestration events:", err));
  },

  startRun: async (opts) => {
    get().ensureListener();
    const runId = await invoke<string>("start_orchestration_run", {
      request: {
        projectId: opts.projectId,
        tasks: opts.tasks,
        adapterId: opts.adapterId,
        options: opts.options,
        maxParallel: opts.maxParallel,
        retryLimit: opts.retryLimit,
        mergePolicy: opts.mergePolicy,
        testCommand: opts.testCommand.trim() || null,
      },
    });

    const tasks: Record<string, RunTaskStatus> = {};
    for (const task of opts.tasks) {
      tasks[task.id] = { task, state: "pending", retryCount: 0, message: null };
    }
    const run: Run = {
      runId,
      projectId: opts.projectId,
      mergePolicy: opts.mergePolicy,
      tasks,
      order: opts.tasks.map((t) => t.id),
      status: "running",
      summary: null,
      error: null,
    };
    set((state) => {
      const buffered = state.pendingEvents[runId] ?? [];
      const hydratedRun = buffered.reduce(applyEvent, run);
      const { [runId]: _replayed, ...remainingPending } = state.pendingEvents;
      return {
        runs: { ...state.runs, [runId]: hydratedRun },
        runOrder: [runId, ...state.runOrder],
        activeRunId: runId,
        pendingEvents: remainingPending,
      };
    });
    return runId;
  },

  confirmPromotion: async (runId) => {
    await invoke("confirm_run_promotion", { runId });
    set((state) => {
      const run = state.runs[runId];
      if (!run) return state;
      return { runs: { ...state.runs, [runId]: { ...run, status: "promoted" } } };
    });
  },

  setActiveRunId: (runId) => set({ activeRunId: runId }),
}));
