// Mirrors src-tauri/src/agents/mod.rs::AgentAvailability. That struct isn't `rename_all =
// "camelCase"` (unlike most other Tauri command payloads in this codebase), so `display_name`
// is kept snake_case here to match the actual wire format, the same way agentSessionStore.ts
// mirrors AgentEvent's field names as-is.
export interface AgentAvailability {
  id: string;
  display_name: string;
  available: boolean;
}
