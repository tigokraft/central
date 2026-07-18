import { invoke } from "@tauri-apps/api/core";

export type FsEntryKind = "file" | "dir";

export interface FsEntry {
  name: string;
  kind: FsEntryKind;
  size: number;
}

// Joins a directory's relative path with a child entry's name into that child's own relative
// path, the form every workspace_fs command expects (root is the empty string).
export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

export function listDir(projectId: string, path: string): Promise<FsEntry[]> {
  return invoke<FsEntry[]>("list_dir", { projectId, path });
}

export function readFile(projectId: string, path: string): Promise<string> {
  return invoke<string>("read_file", { projectId, path });
}

export function writeFile(projectId: string, path: string, content: string): Promise<void> {
  return invoke("write_file", { projectId, path, content });
}

export function createFile(projectId: string, path: string): Promise<void> {
  return invoke("create_file", { projectId, path });
}

export function createDir(projectId: string, path: string): Promise<void> {
  return invoke("create_dir", { projectId, path });
}

export function renamePath(projectId: string, from: string, to: string): Promise<void> {
  return invoke("rename_path", { projectId, from, to });
}

// Tries the system trash first; if that fails (e.g. unsupported platform/sandbox), the caller
// may re-invoke with force=true after an explicit user confirmation to hard-delete instead.
export function deletePath(projectId: string, path: string, force = false): Promise<void> {
  return invoke("delete_path", { projectId, path, force });
}

export function startWorkspaceWatcher(projectId: string): Promise<void> {
  return invoke("start_workspace_watcher", { projectId });
}

export function stopWorkspaceWatcher(): Promise<void> {
  return invoke("stop_workspace_watcher");
}
