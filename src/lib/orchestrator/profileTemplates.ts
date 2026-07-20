import {
  DEFAULT_DECOMPOSER_PROMPT,
  DEFAULT_PLANNER_PROMPT,
  type OrchestratorLaunchOptions,
  type OrchestratorProfile,
} from "../../store/orchestratorProfileStore";

// Literal token GenericCommandAdapter substitutes with the prompt as an inline argument (see
// PROMPT_PLACEHOLDER in src-tauri/src/agents/generic.rs). Templates that omit it fall back to
// stdin delivery instead — right for CLIs like `ollama run <model>` that just read piped input.
const PROMPT_PLACEHOLDER = "{{PROMPT}}";

export interface OrchestratorProfileTemplate {
  id: string;
  label: string;
  // Shown in the template picker; flags any uncertainty about the exact CLI invocation, since
  // these tools' non-interactive flags change across versions and can't be verified from here.
  description: string;
  adapterId: string;
  launchOptions: OrchestratorLaunchOptions;
}

function blankLaunchOptions(commandTemplate = ""): OrchestratorLaunchOptions {
  return { model: "", commandTemplate, extraArgs: "", env: "" };
}

// A curated starting point for common CLI agents, not an exhaustive or authoritative list —
// each one just pre-fills the adapter + command template a reasonable install would need, on
// top of the same generic AgentLaunchOptions/prompts every other profile uses. None of these are
// auto-created; a user has to explicitly pick one from "+ New" to add it, and can freely edit or
// delete it afterward like any other profile.
export const PROFILE_TEMPLATES: OrchestratorProfileTemplate[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    description:
      "Anthropic's claude CLI via the dedicated adapter. Needs `claude` on PATH, authenticated " +
      "interactively or via CLAUDE_CODE_OAUTH_TOKEN for headless use.",
    adapterId: "claude-code",
    launchOptions: blankLaunchOptions(),
  },
  {
    id: "ollama",
    label: "Ollama",
    description:
      "Runs a local model via `ollama run <model>`, prompt delivered over stdin. Swap the " +
      "model name in Command Template for whichever you've pulled locally.",
    adapterId: "generic-command",
    launchOptions: blankLaunchOptions("ollama run llama3.1"),
  },
  {
    id: "gemini-cli",
    label: "Gemini CLI",
    description:
      "Google's gemini CLI in one-shot mode. Flag names shift across versions — verify -p " +
      "still matches `gemini --help` before relying on this.",
    adapterId: "generic-command",
    launchOptions: blankLaunchOptions(`gemini -p ${PROMPT_PLACEHOLDER}`),
  },
  {
    id: "codex-cli",
    label: "Codex CLI",
    description:
      "OpenAI's codex CLI non-interactive `exec` mode. Verify against `codex exec --help` on " +
      "your installed version.",
    adapterId: "generic-command",
    launchOptions: blankLaunchOptions(`codex exec ${PROMPT_PLACEHOLDER}`),
  },
  {
    id: "copilot-cli",
    label: "GitHub Copilot CLI",
    description:
      "GitHub's agentic copilot CLI (not the older `gh copilot suggest`). Least certain of " +
      "this set — verify the prompt flag against `copilot --help` first.",
    adapterId: "generic-command",
    launchOptions: blankLaunchOptions(`copilot -p ${PROMPT_PLACEHOLDER}`),
  },
  {
    id: "blank",
    label: "Blank Custom Command",
    description: "Start from an empty Custom Command profile and fill in your own template.",
    adapterId: "generic-command",
    launchOptions: blankLaunchOptions(),
  },
];

export function instantiateProfileTemplate(template: OrchestratorProfileTemplate): Omit<OrchestratorProfile, "id"> {
  return {
    name: template.label,
    adapterId: template.adapterId,
    launchOptions: template.launchOptions,
    plannerPrompt: DEFAULT_PLANNER_PROMPT,
    decomposerPrompt: DEFAULT_DECOMPOSER_PROMPT,
  };
}
