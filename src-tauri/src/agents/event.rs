use serde::Serialize;

// Normalized event vocabulary every adapter's parse_line() maps its CLI's output onto, so the
// frontend (and pty_manager's spawn/exit hooks) only ever have to understand this one shape
// regardless of which underlying agent produced it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type")]
pub enum AgentEvent {
    Started,
    ToolCall {
        name: String,
        detail: Option<String>,
    },
    FileEdited {
        path: String,
    },
    // No in-tree adapter constructs this yet — ClaudeCode's headless `-p` mode never blocks
    // on interactive approval, and GenericCommand derives no events from content at all. Kept
    // in the vocabulary (and wired into the frontend badge) for adapters added later that do
    // prompt mid-run.
    #[allow(dead_code)]
    NeedsInput {
        question: String,
    },
    Done {
        exit_code: i32,
        summary: Option<String>,
    },
    // Catch-all for output a given adapter doesn't (or can't) interpret, so an unrecognized
    // line is surfaced rather than silently dropped.
    Raw {
        line: String,
    },
}
