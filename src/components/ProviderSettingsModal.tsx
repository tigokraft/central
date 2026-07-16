import { useState } from "react";
import { X, KeyRound, Eye, EyeOff, Cpu } from "lucide-react";
import { useProviderStore, ByokProviderId, PROVIDER_LABELS, PROVIDER_MODELS } from "../store/providerStore";

interface ProviderSettingsModalProps {
  onClose: () => void;
}

const BYOK_PROVIDERS: ByokProviderId[] = ["anthropic", "gemini", "openai"];

export default function ProviderSettingsModal({ onClose }: ProviderSettingsModalProps) {
  const apiKeys = useProviderStore((state) => state.apiKeys);
  const ollamaBaseUrl = useProviderStore((state) => state.ollamaBaseUrl);
  const defaultProvider = useProviderStore((state) => state.defaultProvider);
  const defaultModel = useProviderStore((state) => state.defaultModel);
  const setApiKey = useProviderStore((state) => state.setApiKey);
  const setOllamaBaseUrl = useProviderStore((state) => state.setOllamaBaseUrl);
  const setDefaultProvider = useProviderStore((state) => state.setDefaultProvider);

  const [revealed, setRevealed] = useState<Record<string, boolean>>({});

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-sm flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="w-[420px] max-h-[80vh] overflow-y-auto bg-slate-950 border border-slate-800 rounded-xl shadow-2xl p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3 pb-2 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <KeyRound size={14} className="text-indigo-400" />
            <span className="text-xs font-semibold text-slate-200 uppercase tracking-wide">
              Provider Settings (BYOK)
            </span>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200 transition-colors cursor-pointer">
            <X size={16} />
          </button>
        </div>

        <p className="text-[10px] text-slate-500 mb-3 leading-relaxed">
          Keys are stored locally on this device and used only to call each provider directly from your own
          requests.
        </p>

        <div className="space-y-3">
          {BYOK_PROVIDERS.map((provider) => (
            <div key={provider} className="space-y-1">
              <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">
                {PROVIDER_LABELS[provider]}
              </label>
              <div className="relative">
                <input
                  type={revealed[provider] ? "text" : "password"}
                  value={apiKeys[provider] || ""}
                  onChange={(e) => setApiKey(provider, e.target.value)}
                  placeholder={`${PROVIDER_LABELS[provider]} API key`}
                  className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1.5 pr-8 text-[11px] text-slate-200 placeholder-slate-600 focus:outline-none focus:border-indigo-500/50 font-mono"
                />
                <button
                  type="button"
                  onClick={() => setRevealed((prev) => ({ ...prev, [provider]: !prev[provider] }))}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 cursor-pointer"
                >
                  {revealed[provider] ? <EyeOff size={12} /> : <Eye size={12} />}
                </button>
              </div>
            </div>
          ))}

          <div className="space-y-1">
            <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide flex items-center gap-1.5">
              <Cpu size={11} className="text-slate-500" />
              Ollama Base URL
            </label>
            <input
              type="text"
              value={ollamaBaseUrl}
              onChange={(e) => setOllamaBaseUrl(e.target.value)}
              placeholder="http://localhost:11434"
              className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1.5 text-[11px] text-slate-200 placeholder-slate-600 focus:outline-none focus:border-indigo-500/50 font-mono"
            />
          </div>
        </div>

        <div className="mt-4 pt-3 border-t border-slate-800 space-y-1.5">
          <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">
            Default Provider
          </label>
          <div className="flex gap-1.5">
            <select
              value={defaultProvider}
              onChange={(e) => {
                const provider = e.target.value as keyof typeof PROVIDER_MODELS;
                setDefaultProvider(provider, PROVIDER_MODELS[provider][0].id);
              }}
              className="flex-1 bg-slate-900 border border-slate-800 rounded px-2 py-1.5 text-[11px] text-slate-200 focus:outline-none focus:border-indigo-500/50 cursor-pointer"
            >
              {(Object.keys(PROVIDER_LABELS) as (keyof typeof PROVIDER_LABELS)[]).map((id) => (
                <option key={id} value={id}>
                  {PROVIDER_LABELS[id]}
                </option>
              ))}
            </select>
            <select
              value={defaultModel}
              onChange={(e) => setDefaultProvider(defaultProvider, e.target.value)}
              className="flex-1 bg-slate-900 border border-slate-800 rounded px-2 py-1.5 text-[11px] text-slate-200 focus:outline-none focus:border-indigo-500/50 cursor-pointer"
            >
              {PROVIDER_MODELS[defaultProvider].map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}
