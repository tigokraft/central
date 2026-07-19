import { useState } from "react";
import { type AgentAvailability } from "../../lib/agents";
import Modal from "../ui/Modal";
import Button from "../ui/Button";
import BindingFields, { bindingFieldsToBinding, type BindingFieldsValue } from "./BindingFields";

interface NewSessionModalProps {
  projectId: string;
  agents: AgentAvailability[];
  defaultLabel: string;
  onClose: () => void;
  onCreate: (opts: { label: string; agentId: string | null }, binding: ReturnType<typeof bindingFieldsToBinding>) => void | Promise<void>;
}

export default function NewSessionModal({ projectId, agents, defaultLabel, onClose, onCreate }: NewSessionModalProps) {
  const [label, setLabel] = useState(defaultLabel);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [bindingValue, setBindingValue] = useState<BindingFieldsValue>({
    kind: "main",
    existingBranch: "",
    newBranchName: "",
  });
  const [creating, setCreating] = useState(false);

  const binding = bindingFieldsToBinding(bindingValue);
  const canCreate = label.trim().length > 0 && !!binding;

  const handleCreate = async () => {
    if (!canCreate) return;
    setCreating(true);
    try {
      await onCreate({ label: label.trim(), agentId }, binding);
    } finally {
      setCreating(false);
    }
  };

  return (
    <Modal onClose={onClose} width={420}>
      <p className="text-xs font-semibold text-slate-200 uppercase tracking-wide">New Workbench Session</p>

      <div className="mt-3 space-y-3">
        <div>
          <label className="text-[10px] font-mono text-slate-500 uppercase">Label</label>
          <input
            autoFocus
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="mt-1 w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-emerald-500/50"
          />
        </div>

        <div>
          <label className="text-[10px] font-mono text-slate-500 uppercase">Agent (optional)</label>
          <select
            value={agentId ?? ""}
            onChange={(e) => setAgentId(e.target.value || null)}
            className="mt-1 w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-emerald-500/50"
          >
            <option value="">None — plain terminal</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id} disabled={!a.available}>
                {a.display_name} {a.available ? "" : "(unavailable)"}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-[10px] font-mono text-slate-500 uppercase">Git Binding</label>
          <div className="mt-1">
            <BindingFields projectId={projectId} value={bindingValue} onChange={setBindingValue} />
          </div>
        </div>
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" disabled={!canCreate || creating} onClick={() => void handleCreate()}>
          {creating ? "Creating…" : "Create"}
        </Button>
      </div>
    </Modal>
  );
}
