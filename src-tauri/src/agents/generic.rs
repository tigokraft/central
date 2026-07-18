use super::adapter::{AgentAdapter, AgentLaunchOptions, LaunchSpec};
use super::event::AgentEvent;
use std::path::Path;

pub const GENERIC_COMMAND_ID: &str = "generic-command";

// Runs any user-supplied command line verbatim (e.g. `sh -c 'my-tool --headless'`, or a
// non-Claude CLI's own headless invocation). No output format is assumed, so no adapter-level
// events are derived from what the process prints — only its spawn and exit are meaningful,
// everything in between is just terminal output for the user to read.
pub struct GenericCommandAdapter;

impl AgentAdapter for GenericCommandAdapter {
    fn id(&self) -> &'static str {
        GENERIC_COMMAND_ID
    }

    fn display_name(&self) -> &'static str {
        "Custom Command"
    }

    // Always "available" — it's not backed by one specific binary, the user's template names
    // whatever program it names.
    fn detect(&self) -> bool {
        true
    }

    fn build_launch(&self, prompt: &str, _cwd: &Path, options: &AgentLaunchOptions) -> LaunchSpec {
        let template = options.command_template.clone().unwrap_or_default();
        let mut tokens = tokenize_command(&template);

        if tokens.is_empty() {
            // No template: fall back to treating the prompt itself as an ad-hoc shell
            // command, exactly like a Terminal node's own "Run" button would.
            let (program, flag) = default_shell_invocation();
            return LaunchSpec {
                program,
                args: vec![flag, prompt.to_string()],
                stdin_prompt: None,
            };
        }

        tokens.extend(options.extra_args.iter().cloned());
        let program = tokens.remove(0);
        LaunchSpec {
            program,
            args: tokens,
            // The template doesn't know about the prompt, so it's delivered the way a human
            // would type it in: written to the process's stdin once it's running.
            stdin_prompt: Some(prompt.to_string()),
        }
    }

    fn parse_line(&self, _line: &str) -> Option<AgentEvent> {
        None
    }
}

fn default_shell_invocation() -> (String, String) {
    if cfg!(target_os = "windows") {
        ("cmd".to_string(), "/C".to_string())
    } else {
        ("sh".to_string(), "-c".to_string())
    }
}

// Minimal shell-style word splitter: whitespace-separated tokens, with 'single' and "double"
// quoting (both support \-escaping inside double quotes; single quotes are fully literal,
// matching POSIX). Good enough for a user-authored command template — not a full shell
// grammar (no pipes/redirection/globs as syntax; those pass through as literal characters).
fn tokenize_command(input: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut in_token = false;
    let mut chars = input.chars().peekable();

    while let Some(ch) = chars.next() {
        match ch {
            c if c.is_whitespace() => {
                if in_token {
                    tokens.push(std::mem::take(&mut current));
                    in_token = false;
                }
            }
            '\'' => {
                in_token = true;
                for c in chars.by_ref() {
                    if c == '\'' {
                        break;
                    }
                    current.push(c);
                }
            }
            '"' => {
                in_token = true;
                while let Some(c) = chars.next() {
                    if c == '"' {
                        break;
                    }
                    if c == '\\' {
                        if let Some(&next) = chars.peek() {
                            if next == '"' || next == '\\' {
                                current.push(next);
                                chars.next();
                                continue;
                            }
                        }
                    }
                    current.push(c);
                }
            }
            '\\' => {
                in_token = true;
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            c => {
                in_token = true;
                current.push(c);
            }
        }
    }
    if in_token {
        tokens.push(current);
    }
    tokens
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenizes_plain_whitespace_separated_words() {
        assert_eq!(
            tokenize_command("gh copilot suggest"),
            vec!["gh", "copilot", "suggest"]
        );
    }

    #[test]
    fn keeps_single_quoted_segment_as_one_token() {
        assert_eq!(
            tokenize_command("sh -c 'echo hi; sleep 1'"),
            vec!["sh", "-c", "echo hi; sleep 1"]
        );
    }

    #[test]
    fn double_quotes_support_escaped_quotes() {
        // Runtime content: echo "say \"hi\""
        let input = "echo \"say \\\"hi\\\"\"";
        assert_eq!(tokenize_command(input), vec!["echo", "say \"hi\""]);
    }

    #[test]
    fn empty_template_tokenizes_to_nothing() {
        assert_eq!(tokenize_command(""), Vec::<String>::new());
        assert_eq!(tokenize_command("   "), Vec::<String>::new());
    }

    #[test]
    fn build_launch_with_template_uses_stdin_for_prompt_delivery() {
        let adapter = GenericCommandAdapter;
        let options = AgentLaunchOptions {
            command_template: Some("sh -c 'echo hi; sleep 1'".to_string()),
            ..Default::default()
        };
        let launch = adapter.build_launch("hello", Path::new("/tmp"), &options);
        assert_eq!(launch.program, "sh");
        assert_eq!(launch.args, vec!["-c", "echo hi; sleep 1"]);
        assert_eq!(launch.stdin_prompt, Some("hello".to_string()));
    }

    #[test]
    fn build_launch_without_template_runs_prompt_as_shell_command() {
        let adapter = GenericCommandAdapter;
        let options = AgentLaunchOptions::default();
        let launch = adapter.build_launch("echo hi", Path::new("/tmp"), &options);
        assert_eq!(launch.stdin_prompt, None);
        assert_eq!(launch.args.last(), Some(&"echo hi".to_string()));
    }

    #[test]
    fn parse_line_never_derives_events_from_output() {
        let adapter = GenericCommandAdapter;
        assert_eq!(adapter.parse_line("anything at all"), None);
        assert_eq!(adapter.parse_line(r#"{"type":"result"}"#), None);
    }

    #[test]
    fn detect_is_always_true() {
        assert!(GenericCommandAdapter.detect());
    }
}
