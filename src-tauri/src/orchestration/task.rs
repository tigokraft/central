use serde::{Deserialize, Serialize};

// Mirrors src/lib/orchestrator/schema.ts's OrchestratorTask field-for-field — the Decomposer
// stage's output, already validated (unique ids, acyclic dependsOn) by parseTaskListJson before
// it ever reaches this command, so this module trusts the shape but not the semantics.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorTask {
    pub id: String,
    pub title: String,
    pub prompt: String,
    #[serde(default)]
    pub file_scopes: Vec<String>,
    #[serde(default)]
    pub depends_on: Vec<String>,
}

/// A task's position in the dispatcher/integrator pipeline. `Bounced` is transient: the
/// dispatcher immediately flips it back to `Pending` (with the conflict/test output folded into
/// the task's next prompt) rather than a state anything ever waits in, but it's still emitted as
/// its own event so the UI can show *why* a task is retrying.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskState {
    Pending,
    Running,
    Merging,
    Done,
    Failed,
    Bounced,
}

/// Chosen once at run launch, applied once after every task has reached a terminal state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum MergePolicy {
    #[default]
    HumanGate,
    AutoIfGreen,
}
