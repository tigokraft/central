import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, Bot, Plus, Copy, Trash2 } from "lucide-react";
import { useOrchestratorProfileStore, type AgentAvailability } from "../store/orchestratorProfileStore";
import { PROFILE_TEMPLATES, instantiateProfileTemplate } from "../lib/orchestrator/profileTemplates";
import Modal from "./ui/Modal";

interface OrchestratorProfilesModalProps {
  onClose: () => void;
}

// Settings UI for orchestrator profiles: full CRUD over the role the orchestrator bar fills a
// goal through. Deliberately adapter-agnostic — the launch-option fields (model/command
// template/extra args) are shown for every adapter rather than branching per adapter id, since
// they're already one shared shape (src-tauri/src/agents/adapter.rs::AgentLaunchOptions) that
// any adapter, including ones added later, reads a subset of.
export default function OrchestratorProfilesModal({ onClose }: OrchestratorProfilesModalProps) {
  const profiles = useOrchestratorProfileStore((state) => state.profiles);
  const createProfile = useOrchestratorProfileStore((state) => state.createProfile);
  const updateProfile = useOrchestratorProfileStore((state) => state.updateProfile);
  const duplicateProfile = useOrchestratorProfileStore((state) => state.duplicateProfile);
  const deleteProfile = useOrchestratorProfileStore((state) => state.deleteProfile);

  const [agents, setAgents] = useState<AgentAvailability[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(profiles[0]?.id ?? null);
  const [showTemplateMenu, setShowTemplateMenu] = useState(false);

  useEffect(() => {
    invoke<AgentAvailability[]>("list_available_agents")
      .then(setAgents)
      .catch((err) => console.error("Failed to list available agents:", err));
  }, []);

  useEffect(() => {
    if (selectedId && profiles.some((p) => p.id === selectedId)) return;
    setSelectedId(profiles[0]?.id ?? null);
  }, [profiles, selectedId]);

  useEffect(() => {
    if (!showTemplateMenu) return;
    const close = () => setShowTemplateMenu(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [showTemplateMenu]);

  const selected = profiles.find((p) => p.id === selectedId) ?? null;

  const handleCreateFromTemplate = (templateId: string) => {
    const template = PROFILE_TEMPLATES.find((t) => t.id === templateId);
    if (!template) return;
    setShowTemplateMenu(false);
    const id = createProfile(instantiateProfileTemplate(template));
    setSelectedId(id);
  };

  const handleDuplicate = (id: string) => {
    const newId = duplicateProfile(id);
    if (newId) setSelectedId(newId);
  };

  return (
    <Modal onClose={onClose} width={520}>
      <div className="flex items-center justify-between mb-3 pb-2 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <Bot size={14} className="text-emerald-400" />
          <span className="text-xs font-semibold text-slate-200 uppercase tracking-wide">
            Orchestrator Profiles
          </span>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 transition-colors cursor-pointer">
          <X size={16} />
        </button>
      </div>

      <p className="text-[10px] text-slate-500 mb-3 leading-relaxed">
        A profile pairs an installed CLI agent with launch options and the Planner/Decomposer
        prompts the orchestrator bar uses to turn a goal into a task graph. Any adapter can fill
        this role — nothing here is hardcoded to a specific agent.
      </p>

      <div className="flex flex-wrap gap-1.5 mb-3">
        {profiles.map((profile) => (
          <div
            key={profile.id}
            onClick={() => setSelectedId(profile.id)}
            className={`group flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium cursor-pointer transition-colors ${
              profile.id === selectedId
                ? "bg-emerald-500/10 border border-emerald-500/40 text-emerald-300"
                : "bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200"
            }`}
          >
            <span className="truncate max-w-[120px]">{profile.name}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleDuplicate(profile.id);
              }}
              title="Duplicate"
              className="opacity-0 group-hover:opacity-100 hover:text-emerald-400 transition-opacity cursor-pointer"
            >
              <Copy size={10} />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                deleteProfile(profile.id);
              }}
              title="Delete"
              className="opacity-0 group-hover:opacity-100 hover:text-red-400 transition-opacity cursor-pointer"
            >
              <Trash2 size={10} />
            </button>
          </div>
        ))}
        <div className="relative">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setShowTemplateMenu((v) => !v);
            }}
            title="New Profile"
            className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium bg-slate-900 border border-dashed border-slate-700 text-slate-500 hover:text-emerald-400 hover:border-emerald-500/40 transition-colors cursor-pointer"
          >
            <Plus size={11} />
            New
          </button>
          {showTemplateMenu && (
            <div
              onClick={(e) => e.stopPropagation()}
              className="absolute top-full left-0 mt-1 w-64 bg-slate-900 border border-slate-800 rounded-lg shadow-overlay py-1 z-20"
            >
              {PROFILE_TEMPLATES.map((template) => (
                <button
                  key={template.id}
                  onClick={() => handleCreateFromTemplate(template.id)}
                  title={template.description}
                  className="w-full text-left px-2.5 py-1.5 hover:bg-slate-800 cursor-pointer"
                >
                  <div className="text-[11px] font-medium text-slate-200">{template.label}</div>
                  <div className="text-[9px] text-slate-500 truncate">{template.description}</div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {selected ? (
        <div className="space-y-3 border-t border-slate-800 pt-3">
          <div className="space-y-1">
            <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">Name</label>
            <input
              type="text"
              value={selected.name}
              onChange={(e) => updateProfile(selected.id, { name: e.target.value })}
              className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1.5 text-[11px] text-slate-200 focus:outline-none focus:border-emerald-500/50 font-mono"
            />
          </div>

          <div className="space-y-1">
            <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">
              Agent Adapter
            </label>
            <select
              value={selected.adapterId}
              onChange={(e) => updateProfile(selected.id, { adapterId: e.target.value })}
              className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1.5 text-[11px] text-slate-200 focus:outline-none focus:border-emerald-500/50 cursor-pointer"
            >
              {selected.adapterId && !agents.some((a) => a.id === selected.adapterId) && (
                <option value={selected.adapterId}>{selected.adapterId} (not detected)</option>
              )}
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.display_name}
                  {agent.available ? "" : " (not detected)"}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-1">
              <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">Model</label>
              <input
                type="text"
                value={selected.launchOptions.model}
                onChange={(e) =>
                  updateProfile(selected.id, {
                    launchOptions: { ...selected.launchOptions, model: e.target.value },
                  })
                }
                placeholder="(default)"
                className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1.5 text-[11px] text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500/50 font-mono"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">
                Command Template
              </label>
              <input
                type="text"
                value={selected.launchOptions.commandTemplate}
                onChange={(e) =>
                  updateProfile(selected.id, {
                    launchOptions: { ...selected.launchOptions, commandTemplate: e.target.value },
                  })
                }
                placeholder="e.g. gemini -p {{PROMPT}}"
                className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1.5 text-[11px] text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500/50 font-mono"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">
                Extra Args
              </label>
              <input
                type="text"
                value={selected.launchOptions.extraArgs}
                onChange={(e) =>
                  updateProfile(selected.id, {
                    launchOptions: { ...selected.launchOptions, extraArgs: e.target.value },
                  })
                }
                placeholder="--effort high"
                className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1.5 text-[11px] text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500/50 font-mono"
              />
            </div>
          </div>
          <p className="text-[9px] text-slate-600 leading-relaxed -mt-2">
            Only used by the Custom Command adapter. Include <code>{"{{PROMPT}}"}</code> in the
            template to pass the prompt as an inline argument (e.g. <code>gemini -p {"{{PROMPT}}"}</code>);
            omit it and the prompt is piped over stdin instead (e.g. <code>ollama run llama3.1</code>).
          </p>

          <div className="space-y-1">
            <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">
              Environment Variables
            </label>
            <textarea
              value={selected.launchOptions.env ?? ""}
              onChange={(e) =>
                updateProfile(selected.id, {
                  launchOptions: { ...selected.launchOptions, env: e.target.value },
                })
              }
              placeholder={"CLAUDE_CODE_OAUTH_TOKEN=...\nONE_PER_LINE=..."}
              rows={2}
              data-nodrag
              className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1.5 text-[11px] text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500/50 font-mono resize-none"
            />
            <p className="text-[9px] text-slate-600 leading-relaxed">
              One KEY=VALUE per line. Only reaches this adapter's own process — never your shell
              environment. Stored locally on this device, same as Provider Settings.
            </p>
          </div>

          <div className="space-y-1">
            <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">
              Planner Prompt
            </label>
            <textarea
              value={selected.plannerPrompt}
              onChange={(e) => updateProfile(selected.id, { plannerPrompt: e.target.value })}
              rows={4}
              data-nodrag
              className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1.5 text-[11px] text-slate-200 focus:outline-none focus:border-emerald-500/50 font-mono resize-none"
            />
          </div>

          <div className="space-y-1">
            <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">
              Decomposer Prompt
            </label>
            <textarea
              value={selected.decomposerPrompt}
              onChange={(e) => updateProfile(selected.id, { decomposerPrompt: e.target.value })}
              rows={6}
              data-nodrag
              className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1.5 text-[11px] text-slate-200 focus:outline-none focus:border-emerald-500/50 font-mono resize-none"
            />
          </div>
        </div>
      ) : (
        <div className="text-[11px] text-slate-500 border-t border-slate-800 pt-3 text-center py-4">
          No orchestrator profile yet. Goals fall back to the offline keyword parser until one is
          created.
        </div>
      )}
    </Modal>
  );
}
