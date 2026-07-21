// Mirrors src-tauri/src/orchestration/{task,run}.rs's serde shapes field-for-field. Both the
// outer struct (StartOrchestrationRunRequest/OrchestrationEventPayload) and TaskState/MergePolicy
// carry #[serde(rename_all = "camelCase")], and RunEvent is internally tagged on "type" with the
// variant names themselves also camelCased.

export type TaskState = "pending" | "running" | "merging" | "done" | "failed" | "bounced";

export type MergePolicy = "humanGate" | "autoIfGreen";

export type RunEvent =
  | { type: "taskState"; taskId: string; state: TaskState; retryCount: number; message: string | null }
  | { type: "runComplete"; done: number; failed: number; awaitingConfirmation: boolean; autoPromoted: boolean }
  | { type: "runFailed"; message: string };

export interface OrchestrationEventPayload {
  runId: string;
  projectId: string;
  event: RunEvent;
}
