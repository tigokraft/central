import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AgentEvent } from "../../store/agentSessionStore";
import type { AgentLaunchOptionsPayload } from "../../store/orchestratorProfileStore";

// Drives a single headless turn of a CLI agent via the existing launch_agent_session/agent-event
// plumbing (src-tauri/src/agents/mod.rs), for the orchestrator's Planner/Decomposer stages. No
// TerminalNode/xterm is involved — launch_agent_session spawns its own PTY under a synthetic
// node id, and this just listens for that node id's events until the session finishes.

const HEADLESS_TIMEOUT_MS = 5 * 60 * 1000;

// Same minimal ANSI/CSI/OSC stripping as TerminalNode.tsx's local stripAnsiCodes — duplicated
// rather than imported since that one is a private helper inside a component file, not shared.
function stripAnsiCodes(text: string): string {
  return text
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b[()][A-Za-z0-9]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

export interface HeadlessAgentResult {
  text: string;
  ok: boolean;
}

// Runs one adapter invocation to completion and resolves with its text output. Prefers the
// adapter-reported Done.summary (e.g. ClaudeCode's final result text) when present; otherwise
// falls back to the raw accumulated PTY output (ANSI-stripped) — the only signal a
// GenericCommandAdapter session ever produces, since its parse_line never derives events from
// content. launch_agent_session's on_exit hook always synthesizes a Done event if the adapter
// itself never reported one, so listening only for "agent-event" Done is sufficient — no need
// to also watch "pty-exit".
export async function runAgentHeadless(
  adapterId: string,
  prompt: string,
  options: AgentLaunchOptionsPayload,
  cwd: string
): Promise<HeadlessAgentResult> {
  const nodeId = `orchestrator-headless-${crypto.randomUUID()}`;
  let rawOutput = "";
  let settled = false;

  return new Promise<HeadlessAgentResult>((resolve) => {
    let unlistenAgentEvent: (() => void) | null = null;
    let unlistenPtyOutput: (() => void) | null = null;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    const finish = (ok: boolean, summary: string | null) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      unlistenAgentEvent?.();
      unlistenPtyOutput?.();
      invoke("destroy_pty", { nodeId }).catch(() => {});
      const fallbackText = stripAnsiCodes(rawOutput).trim();
      resolve({ text: summary?.trim() || fallbackText, ok });
    };

    void (async () => {
      try {
        unlistenAgentEvent = await listen<{ node_id: string; event: AgentEvent }>("agent-event", (event) => {
          if (event.payload.node_id !== nodeId) return;
          const evt = event.payload.event;
          if (evt.type === "Done") {
            finish(evt.exit_code === 0, evt.summary);
          }
        });
        unlistenPtyOutput = await listen<{ node_id: string; data: string }>("pty-output", (event) => {
          if (event.payload.node_id !== nodeId) return;
          rawOutput += event.payload.data;
        });

        timeoutHandle = setTimeout(() => finish(false, null), HEADLESS_TIMEOUT_MS);

        await invoke("launch_agent_session", {
          request: { nodeId, adapterId, prompt, cwd, options },
        });
      } catch (err) {
        console.error("Failed to launch headless agent session:", err);
        finish(false, null);
      }
    })();
  });
}

// Wraps the new build_task_command_line Tauri command (src-tauri/src/agents/mod.rs): renders an
// adapter's headless CLI invocation as a shell command line that reads its prompt from
// $CENTRAL_PIPELINE_INPUT at run time, for embedding into a materialized task node's `actions`.
export async function buildTaskCommandLine(
  adapterId: string,
  options: AgentLaunchOptionsPayload
): Promise<string> {
  return invoke<string>("build_task_command_line", { adapterId, options });
}
