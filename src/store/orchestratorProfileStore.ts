import { create } from "zustand";
import { persist } from "zustand/middleware";
import { invoke } from "@tauri-apps/api/core";

// Mirrors src-tauri/src/agents/mod.rs::AgentAvailability, which has no #[serde(rename_all)] of
// its own — its JSON keys stay snake_case even though most other Tauri command payloads in this
// app are camelCase.
export interface AgentAvailability {
  id: string;
  display_name: string;
  available: boolean;
}

export interface OrchestratorLaunchOptions {
  model: string;
  commandTemplate: string;
  // Space-separated; split into a string[] only at the Tauri-call boundary.
  extraArgs: string;
  // One KEY=VALUE pair per line; parsed into a map only at the Tauri-call boundary. Adapter-
  // agnostic — e.g. a headless CLI's own auth token — layered onto the spawned process's
  // environment server-side, so it never needs to live in the shell that launched the app.
  env: string;
}

export interface OrchestratorProfile {
  id: string;
  name: string;
  adapterId: string;
  launchOptions: OrchestratorLaunchOptions;
  plannerPrompt: string;
  decomposerPrompt: string;
}

// Mirrors src-tauri/src/agents/adapter.rs::AgentLaunchOptions field-for-field. That struct also
// has no #[serde(rename_all)], so — unlike LaunchAgentSessionRequest's own top-level fields —
// its keys must stay snake_case here too.
export interface AgentLaunchOptionsPayload {
  model?: string;
  command_template?: string;
  extra_args: string[];
  env: Record<string, string>;
}

// Parses "KEY=VALUE" lines into a map, skipping blank lines and lines with no "=" or an empty
// key. Defensive against fields absent from profiles persisted before `env` existed (no schema
// migration is configured on this store, so older localStorage entries simply lack the key).
function parseEnvLines(raw: string | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of (raw ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

export function toAgentLaunchOptionsPayload(options: OrchestratorLaunchOptions): AgentLaunchOptionsPayload {
  return {
    model: options.model.trim() || undefined,
    command_template: options.commandTemplate.trim() || undefined,
    extra_args: options.extraArgs.trim() ? options.extraArgs.trim().split(/\s+/) : [],
    env: parseEnvLines(options.env),
  };
}

export const DEFAULT_PLANNER_PROMPT =
  "You are a senior engineering lead scoping work in an existing repository. Given a goal, " +
  "write a short, concrete implementation plan as a few sentences or a short bullet list. " +
  "Focus on the sequence of concrete engineering steps and the files/areas likely involved. " +
  "Do not write code, and do not ask clarifying questions — make reasonable assumptions.";

export const DEFAULT_DECOMPOSER_PROMPT =
  "You are a task decomposition engine. Given a goal and an implementation plan, break the " +
  "work into a small number of discrete engineering tasks (typically 2-5) that can each be " +
  "carried out independently by an autonomous coding agent. Respond with ONLY a JSON array " +
  "(no prose, no markdown code fences) where each element has exactly this shape: " +
  '{ "id": string, "title": string, "prompt": string, "fileScopes": string[], "dependsOn": string[] }. ' +
  '"id" must be a short unique slug. "dependsOn" lists the "id"s of tasks that must finish ' +
  'first (empty array if none). "fileScopes" lists the files or directories the task is ' +
  'expected to touch. Every "prompt" must be self-contained enough for a coding agent to ' +
  "execute without any additional context beyond it.";

function newProfileId(): string {
  return `orchestrator-profile-${crypto.randomUUID()}`;
}

interface OrchestratorProfileState {
  profiles: OrchestratorProfile[];
  // projectId -> profileId. Absent entries fall back to the first remaining profile.
  projectActiveProfileId: Record<string, string>;
  // Persisted so a user who deletes the seeded default down to zero profiles never has it
  // silently resurrected on next launch.
  hasSeededDefault: boolean;

  createProfile: (input: Omit<OrchestratorProfile, "id">) => string;
  updateProfile: (id: string, patch: Partial<Omit<OrchestratorProfile, "id">>) => void;
  duplicateProfile: (id: string) => string | null;
  deleteProfile: (id: string) => void;
  getActiveProfileId: (projectId: string | null) => string | null;
  setActiveProfileId: (projectId: string, profileId: string) => void;
  ensureDefaultProfile: () => Promise<void>;
}

export const useOrchestratorProfileStore = create<OrchestratorProfileState>()(
  persist(
    (set, get) => ({
      profiles: [],
      projectActiveProfileId: {},
      hasSeededDefault: false,

      createProfile: (input) => {
        const id = newProfileId();
        set((state) => ({ profiles: [...state.profiles, { ...input, id }] }));
        return id;
      },

      updateProfile: (id, patch) =>
        set((state) => ({
          profiles: state.profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)),
        })),

      duplicateProfile: (id) => {
        const source = get().profiles.find((p) => p.id === id);
        if (!source) return null;
        const newId = newProfileId();
        set((state) => ({
          profiles: [...state.profiles, { ...source, id: newId, name: `${source.name} copy` }],
        }));
        return newId;
      },

      deleteProfile: (id) =>
        set((state) => {
          const projectActiveProfileId = { ...state.projectActiveProfileId };
          for (const projectId of Object.keys(projectActiveProfileId)) {
            if (projectActiveProfileId[projectId] === id) delete projectActiveProfileId[projectId];
          }
          return {
            profiles: state.profiles.filter((p) => p.id !== id),
            projectActiveProfileId,
          };
        }),

      getActiveProfileId: (projectId) => {
        const { profiles, projectActiveProfileId } = get();
        if (profiles.length === 0) return null;
        const override = projectId ? projectActiveProfileId[projectId] : undefined;
        if (override && profiles.some((p) => p.id === override)) return override;
        return profiles[0].id;
      },

      setActiveProfileId: (projectId, profileId) =>
        set((state) => ({
          projectActiveProfileId: { ...state.projectActiveProfileId, [projectId]: profileId },
        })),

      ensureDefaultProfile: async () => {
        if (get().hasSeededDefault || get().profiles.length > 0) return;
        set({ hasSeededDefault: true });

        let adapterId = "claude-code";
        try {
          const agents = await invoke<AgentAvailability[]>("list_available_agents");
          const firstAvailable = agents.find((a) => a.available);
          if (firstAvailable) adapterId = firstAvailable.id;
          else if (agents.length > 0) adapterId = agents[0].id;
        } catch (err) {
          console.error("Failed to detect available agents for default orchestrator profile:", err);
        }

        get().createProfile({
          name: "Default",
          adapterId,
          launchOptions: { model: "", commandTemplate: "", extraArgs: "", env: "" },
          plannerPrompt: DEFAULT_PLANNER_PROMPT,
          decomposerPrompt: DEFAULT_DECOMPOSER_PROMPT,
        });
      },
    }),
    { name: "central-orchestrator-profiles" }
  )
);
