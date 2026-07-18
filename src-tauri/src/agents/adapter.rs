use super::event::AgentEvent;
use serde::Deserialize;
use std::path::Path;

// Adapter-specific launch tuning. Every field is optional since most adapters only care about
// a subset — ClaudeCode reads `model`/`extra_args`, GenericCommand reads `command_template`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct AgentLaunchOptions {
    pub model: Option<String>,
    pub command_template: Option<String>,
    pub extra_args: Vec<String>,
}

// What to actually spawn (argv, not shell text) plus, optionally, text to write to the
// process's stdin once it's running — used by adapters that take their prompt interactively
// rather than as a launch argument.
#[derive(Debug, Clone, PartialEq)]
pub struct LaunchSpec {
    pub program: String,
    pub args: Vec<String>,
    pub stdin_prompt: Option<String>,
}

pub trait AgentAdapter: Send + Sync {
    fn id(&self) -> &'static str;
    fn display_name(&self) -> &'static str;

    // Whether this adapter's underlying binary is available right now. Must be cheap and
    // side-effect free (a PATH scan, not a subprocess spawn) since it's called for every
    // adapter on every list_available_agents refresh.
    fn detect(&self) -> bool;

    fn build_launch(&self, prompt: &str, cwd: &Path, options: &AgentLaunchOptions) -> LaunchSpec;

    // Parses one line of the child process's stdout/stderr (already split on newlines and
    // trimmed of the trailing \r\n a PTY's line discipline adds) into a normalized event.
    // Returning None means the line carries no event-worthy information at all (skip it,
    // don't even surface it as Raw).
    fn parse_line(&self, line: &str) -> Option<AgentEvent>;
}
