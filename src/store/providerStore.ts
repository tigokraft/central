import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ProviderId = "anthropic" | "gemini" | "openai" | "ollama";
export type ByokProviderId = Exclude<ProviderId, "ollama">;

export interface ProviderModelOption {
  id: string;
  label: string;
}

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: "Anthropic (Claude)",
  gemini: "Google Gemini",
  openai: "OpenAI",
  ollama: "Ollama (local)",
};

export const PROVIDER_MODELS: Record<ProviderId, ProviderModelOption[]> = {
  anthropic: [
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  ],
  gemini: [
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  ],
  openai: [
    { id: "gpt-5", label: "GPT-5" },
    { id: "gpt-5-mini", label: "GPT-5 Mini" },
  ],
  ollama: [
    { id: "llama3", label: "Llama 3 (local)" },
    { id: "qwen2.5-coder", label: "Qwen 2.5 Coder (local)" },
  ],
};

export interface NodeProviderAssignment {
  provider: ProviderId;
  model: string;
}

interface ProviderState {
  apiKeys: Partial<Record<ByokProviderId, string>>;
  ollamaBaseUrl: string;
  defaultProvider: ProviderId;
  defaultModel: string;
  // Per-node provider overrides (e.g. Gemini for a Coder node, Claude for a Reviewer node).
  nodeProviders: Record<string, NodeProviderAssignment>;

  setApiKey: (provider: ByokProviderId, key: string) => void;
  setOllamaBaseUrl: (url: string) => void;
  setDefaultProvider: (provider: ProviderId, model: string) => void;
  setNodeProvider: (nodeId: string, provider: ProviderId, model: string) => void;
  clearNodeProvider: (nodeId: string) => void;
}

export const useProviderStore = create<ProviderState>()(
  persist(
    (set) => ({
      apiKeys: {},
      ollamaBaseUrl: "http://localhost:11434",
      defaultProvider: "anthropic",
      defaultModel: PROVIDER_MODELS.anthropic[0].id,
      nodeProviders: {},

      setApiKey: (provider, key) => set((state) => ({ apiKeys: { ...state.apiKeys, [provider]: key } })),

      setOllamaBaseUrl: (url) => set({ ollamaBaseUrl: url }),

      setDefaultProvider: (provider, model) => set({ defaultProvider: provider, defaultModel: model }),

      setNodeProvider: (nodeId, provider, model) =>
        set((state) => ({ nodeProviders: { ...state.nodeProviders, [nodeId]: { provider, model } } })),

      clearNodeProvider: (nodeId) =>
        set((state) => {
          const next = { ...state.nodeProviders };
          delete next[nodeId];
          return { nodeProviders: next };
        }),
    }),
    { name: "central-provider-settings" }
  )
);
