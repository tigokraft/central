import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { type WorkbenchBinding } from "../../lib/workbench";

export interface BindingFieldsValue {
  kind: WorkbenchBinding["kind"];
  existingBranch: string;
  newBranchName: string;
}

export function bindingFieldsToBinding(value: BindingFieldsValue): WorkbenchBinding | null {
  if (value.kind === "main") return { kind: "main" };
  if (value.kind === "existing") return value.existingBranch ? { kind: "existing", branch: value.existingBranch } : null;
  return value.newBranchName.trim() ? { kind: "new", branch: value.newBranchName.trim() } : null;
}

interface BindingFieldsProps {
  projectId: string;
  value: BindingFieldsValue;
  onChange: (value: BindingFieldsValue) => void;
}

// The git-binding radio group (main / existing branch / new branch), shared by BindingPicker
// (rebinding an idle session) and the new-session modal, so neither has to nest one Modal
// inside another.
export default function BindingFields({ projectId, value, onChange }: BindingFieldsProps) {
  const [branches, setBranches] = useState<string[]>([]);

  useEffect(() => {
    invoke<string[]>("list_branches", { projectId })
      .then((list) => {
        setBranches(list);
        if (!value.existingBranch && list.length > 0) onChange({ ...value, existingBranch: list[0] });
      })
      .catch((err) => console.error("Failed to list branches:", err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
        <input type="radio" checked={value.kind === "main"} onChange={() => onChange({ ...value, kind: "main" })} />
        Main (run directly in the workspace)
      </label>
      <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
        <input
          type="radio"
          checked={value.kind === "existing"}
          onChange={() => onChange({ ...value, kind: "existing" })}
        />
        Existing branch
      </label>
      {value.kind === "existing" && (
        <select
          value={value.existingBranch}
          onChange={(e) => onChange({ ...value, existingBranch: e.target.value })}
          className="ml-6 bg-slate-900 border border-slate-800 rounded px-2 py-1 text-xs text-slate-200 w-[calc(100%-1.5rem)] focus:outline-none focus:border-emerald-500/50"
        >
          {branches.length === 0 && <option value="">No branches found</option>}
          {branches.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
      )}
      <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
        <input type="radio" checked={value.kind === "new"} onChange={() => onChange({ ...value, kind: "new" })} />
        New branch
      </label>
      {value.kind === "new" && (
        <input
          autoFocus
          value={value.newBranchName}
          onChange={(e) => onChange({ ...value, newBranchName: e.target.value })}
          placeholder="branch-name"
          className="ml-6 bg-slate-900 border border-slate-800 rounded px-2 py-1 text-xs text-slate-200 w-[calc(100%-1.5rem)] focus:outline-none focus:border-emerald-500/50"
        />
      )}
    </div>
  );
}
