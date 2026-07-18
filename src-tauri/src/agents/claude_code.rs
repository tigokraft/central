use super::adapter::{AgentAdapter, AgentLaunchOptions, LaunchSpec};
use super::event::AgentEvent;
use super::path_detect::is_executable_on_path;
use std::path::Path;

pub const CLAUDE_CODE_ID: &str = "claude-code";
const BIN_NAME: &str = "claude";

// Drives `claude` in fully headless mode (`-p`), reading its `--output-format stream-json`
// JSONL stream. Never touches the network/API directly — this only ever shells out to the
// CLI the user already has installed and authenticated.
pub struct ClaudeCodeAdapter;

impl AgentAdapter for ClaudeCodeAdapter {
    fn id(&self) -> &'static str {
        CLAUDE_CODE_ID
    }

    fn display_name(&self) -> &'static str {
        "Claude Code"
    }

    fn detect(&self) -> bool {
        let path_env = std::env::var("PATH").unwrap_or_default();
        is_executable_on_path(BIN_NAME, &path_env)
    }

    fn build_launch(&self, prompt: &str, _cwd: &Path, options: &AgentLaunchOptions) -> LaunchSpec {
        let mut args = vec![
            "-p".to_string(),
            prompt.to_string(),
            "--output-format".to_string(),
            "stream-json".to_string(),
            "--verbose".to_string(),
        ];
        if let Some(model) = &options.model {
            args.push("--model".to_string());
            args.push(model.clone());
        }
        args.extend(options.extra_args.iter().cloned());

        LaunchSpec {
            program: BIN_NAME.to_string(),
            args,
            // The prompt travels as a `-p` argument, not stdin.
            stdin_prompt: None,
        }
    }

    fn parse_line(&self, line: &str) -> Option<AgentEvent> {
        parse_stream_json_line(line)
    }
}

fn parse_stream_json_line(line: &str) -> Option<AgentEvent> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }

    let value: serde_json::Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(_) => {
            return Some(AgentEvent::Raw {
                line: trimmed.to_string(),
            })
        }
    };

    match value.get("type").and_then(|t| t.as_str()).unwrap_or("") {
        "assistant" => Some(tool_use_event(&value).unwrap_or(AgentEvent::Raw {
            line: trimmed.to_string(),
        })),
        "result" => {
            let is_error = value
                .get("is_error")
                .and_then(|b| b.as_bool())
                .unwrap_or(false);
            let summary = value
                .get("result")
                .and_then(|s| s.as_str())
                .map(|s| s.to_string());
            Some(AgentEvent::Done {
                exit_code: if is_error { 1 } else { 0 },
                summary,
            })
        }
        // Includes "system" (init/api_retry/...) and anything future CLI versions add —
        // deliberately unmapped rather than guessed at.
        _ => Some(AgentEvent::Raw {
            line: trimmed.to_string(),
        }),
    }
}

// Looks for the first tool_use content block in an assistant message and turns it into
// either a FileEdited (when the tool clearly wrote to a file path) or a generic ToolCall.
// A message with multiple tool_use blocks only yields its first — parse_line hands back a
// single event per line, matching the adapter trait's signature.
fn tool_use_event(value: &serde_json::Value) -> Option<AgentEvent> {
    let blocks = value.pointer("/message/content")?.as_array()?;
    let block = blocks
        .iter()
        .find(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_use"))?;
    let name = block
        .get("name")
        .and_then(|n| n.as_str())
        .unwrap_or("unknown")
        .to_string();
    let input = block.get("input");

    if matches!(name.as_str(), "Edit" | "Write" | "NotebookEdit") {
        if let Some(path) = input
            .and_then(|i| i.get("file_path"))
            .and_then(|p| p.as_str())
        {
            return Some(AgentEvent::FileEdited {
                path: path.to_string(),
            });
        }
    }

    let detail = input.map(|i| i.to_string());
    Some(AgentEvent::ToolCall { name, detail })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn init_system_line_is_raw() {
        let line = r#"{"type":"system","subtype":"init","cwd":"/tmp","session_id":"abc"}"#;
        assert_eq!(
            parse_stream_json_line(line),
            Some(AgentEvent::Raw {
                line: line.to_string()
            })
        );
    }

    #[test]
    fn edit_tool_call_becomes_file_edited() {
        let line = r#"{"type":"assistant","message":{"content":[
            {"type":"tool_use","id":"t1","name":"Edit","input":{"file_path":"/tmp/hello.txt","old_string":"a","new_string":"b"}}
        ]}}"#;
        assert_eq!(
            parse_stream_json_line(line),
            Some(AgentEvent::FileEdited {
                path: "/tmp/hello.txt".to_string()
            })
        );
    }

    #[test]
    fn bash_tool_call_becomes_generic_tool_call() {
        let line = r#"{"type":"assistant","message":{"content":[
            {"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls -la"}}
        ]}}"#;
        let event = parse_stream_json_line(line).unwrap();
        match event {
            AgentEvent::ToolCall { name, detail } => {
                assert_eq!(name, "Bash");
                assert!(detail.unwrap().contains("ls -la"));
            }
            other => panic!("expected ToolCall, got {other:?}"),
        }
    }

    #[test]
    fn text_only_assistant_message_falls_back_to_raw() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}"#;
        assert_eq!(
            parse_stream_json_line(line),
            Some(AgentEvent::Raw {
                line: line.to_string()
            })
        );
    }

    #[test]
    fn successful_result_becomes_done_with_zero_exit_code() {
        let line = r#"{"type":"result","subtype":"success","is_error":false,"result":"Created hello.txt"}"#;
        assert_eq!(
            parse_stream_json_line(line),
            Some(AgentEvent::Done {
                exit_code: 0,
                summary: Some("Created hello.txt".to_string())
            })
        );
    }

    #[test]
    fn error_result_becomes_done_with_nonzero_exit_code() {
        let line =
            r#"{"type":"result","subtype":"error","is_error":true,"result":"401 unauthorized"}"#;
        assert_eq!(
            parse_stream_json_line(line),
            Some(AgentEvent::Done {
                exit_code: 1,
                summary: Some("401 unauthorized".to_string())
            })
        );
    }

    #[test]
    fn malformed_json_becomes_raw() {
        let line = "{not valid json";
        assert_eq!(
            parse_stream_json_line(line),
            Some(AgentEvent::Raw {
                line: line.to_string()
            })
        );
    }

    #[test]
    fn unknown_top_level_type_becomes_raw() {
        let line = r#"{"type":"stream_event","subtype":"partial"}"#;
        assert_eq!(
            parse_stream_json_line(line),
            Some(AgentEvent::Raw {
                line: line.to_string()
            })
        );
    }

    #[test]
    fn blank_line_is_ignored() {
        assert_eq!(parse_stream_json_line("   "), None);
    }

    #[test]
    fn build_launch_includes_prompt_and_stream_json_flags() {
        let adapter = ClaudeCodeAdapter;
        let options = AgentLaunchOptions::default();
        let launch = adapter.build_launch("say hi", Path::new("/tmp"), &options);
        assert_eq!(launch.program, "claude");
        assert_eq!(
            launch.args,
            vec![
                "-p",
                "say hi",
                "--output-format",
                "stream-json",
                "--verbose"
            ]
        );
        assert_eq!(launch.stdin_prompt, None);
    }

    #[test]
    fn build_launch_appends_model_and_extra_args() {
        let adapter = ClaudeCodeAdapter;
        let options = AgentLaunchOptions {
            model: Some("sonnet".to_string()),
            extra_args: vec!["--effort".to_string(), "high".to_string()],
            ..Default::default()
        };
        let launch = adapter.build_launch("say hi", Path::new("/tmp"), &options);
        assert_eq!(
            launch.args,
            vec![
                "-p",
                "say hi",
                "--output-format",
                "stream-json",
                "--verbose",
                "--model",
                "sonnet",
                "--effort",
                "high"
            ]
        );
    }
}
