import { invoke } from "@tauri-apps/api/core";

export type GitFileStatus = "modified" | "added" | "untracked";

export interface GitStatusEntry {
  path: string;
  status: GitFileStatus;
}

export function getGitStatus(projectId: string): Promise<GitStatusEntry[]> {
  return invoke<GitStatusEntry[]>("get_git_status", { projectId });
}

export function getFileAtHead(projectId: string, path: string): Promise<string | null> {
  return invoke<string | null>("get_file_at_head", { projectId, path });
}
