import { useState } from "react";
import { type WorkbenchBinding } from "../../lib/workbench";
import Modal from "../ui/Modal";
import Button from "../ui/Button";
import BindingFields, { bindingFieldsToBinding, type BindingFieldsValue } from "./BindingFields";

interface BindingPickerProps {
  projectId: string;
  initial?: WorkbenchBinding;
  onCancel: () => void;
  onConfirm: (binding: WorkbenchBinding) => void | Promise<void>;
}

// Modal used to change an idle session's git binding. Session creation uses the same
// BindingFields inline (see NewSessionModal) rather than nesting this modal inside another.
export default function BindingPicker({ projectId, initial, onCancel, onConfirm }: BindingPickerProps) {
  const [value, setValue] = useState<BindingFieldsValue>({
    kind: initial?.kind ?? "main",
    existingBranch: initial?.kind === "existing" ? initial.branch : "",
    newBranchName: initial?.kind === "new" ? initial.branch : "",
  });

  const binding = bindingFieldsToBinding(value);

  return (
    <Modal onClose={onCancel} width={380}>
      <p className="text-xs font-semibold text-slate-200 uppercase tracking-wide">Git Binding</p>
      <div className="mt-3">
        <BindingFields projectId={projectId} value={value} onChange={setValue} />
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" disabled={!binding} onClick={() => binding && void onConfirm(binding)}>
          Confirm
        </Button>
      </div>
    </Modal>
  );
}
