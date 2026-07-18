import { create } from "zustand";

// Mirrors src-tauri/src/agents/event.rs::AgentEvent — kept in lockstep manually since the
// backend emits these as plain serde-tagged JSON over the "agent-event" Tauri event.
export type AgentEvent =
  | { type: "Started" }
  | { type: "ToolCall"; name: string; detail: string | null }
  | { type: "FileEdited"; path: string }
  | { type: "NeedsInput"; question: string }
  | { type: "Done"; exit_code: number; summary: string | null }
  | { type: "Raw"; line: string };

interface AgentSessionState {
  // Only the latest event per node — rich history (a scrollable event log) is for a later PR;
  // this is just enough to drive a terminal node's status badge.
  eventsByNode: Record<string, AgentEvent>;
  setEvent: (nodeId: string, event: AgentEvent) => void;
  clearEvent: (nodeId: string) => void;
}

export const useAgentSessionStore = create<AgentSessionState>((set) => ({
  eventsByNode: {},

  setEvent: (nodeId, event) =>
    set((state) => ({ eventsByNode: { ...state.eventsByNode, [nodeId]: event } })),

  clearEvent: (nodeId) =>
    set((state) => {
      if (!(nodeId in state.eventsByNode)) return state;
      const eventsByNode = { ...state.eventsByNode };
      delete eventsByNode[nodeId];
      return { eventsByNode };
    }),
}));
