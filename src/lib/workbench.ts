// Mirrors src-tauri/src/git_engine.rs::WorkbenchBinding (tagged on "kind") and
// project.rs::WorkbenchSessionMeta.
export type WorkbenchBinding =
  | { kind: "main" }
  | { kind: "existing"; branch: string }
  | { kind: "new"; branch: string };

export interface WorkbenchSessionMeta {
  id: string;
  label: string;
  agentId: string | null;
  binding: WorkbenchBinding;
}

export interface PromoteResult {
  branch: string;
  mergeCommitSha: string | null;
  fastForward: boolean;
  upToDate: boolean;
}

// Short label for a binding, shown on the session card.
export function bindingLabel(binding: WorkbenchBinding): string {
  switch (binding.kind) {
    case "main":
      return "main";
    case "existing":
      return binding.branch;
    case "new":
      return binding.branch;
  }
}
