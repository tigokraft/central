use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use git2::{IndexAddOption, Oid, Repository, ResetType, Signature};
use serde::Serialize;
use tauri::State;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub node_id: String,
    pub worktree_name: String,
    pub path: String,
    pub base_commit: String,
    pub head_commit: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HandoffResult {
    pub node_id: String,
    pub target_node_id: String,
    pub commit_sha: String,
    pub insertions: usize,
    pub deletions: usize,
    pub files_changed: usize,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RepoHeadInfo {
    pub branch: String,
    pub commit_sha: String,
}

struct WorktreeHandle {
    worktree_name: String,
    path: PathBuf,
    base_commit: String,
}

#[derive(Default)]
pub struct GitEngineState {
    worktrees: Mutex<HashMap<String, WorktreeHandle>>,
}

// Monotonic counter guarantees unique worktree/branch names even when two nodes are
// prepared within the same millisecond.
static WORKTREE_SEQ: AtomicU64 = AtomicU64::new(0);

fn sanitize(id: &str) -> String {
    id.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect()
}

fn timestamp_millis() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

fn head_commit_sha(repo_path: &Path) -> Option<String> {
    let repo = Repository::open(repo_path).ok()?;
    let head = repo.head().ok()?;
    let commit = head.peel_to_commit().ok()?;
    Some(commit.id().to_string())
}

fn prune_worktree(repo: &Repository, handle: &WorktreeHandle) {
    if let Ok(wt) = repo.find_worktree(&handle.worktree_name) {
        let mut opts = git2::WorktreePruneOptions::new();
        opts.working_tree(true);
        let _ = wt.prune(Some(&mut opts));
    }
    let _ = std::fs::remove_dir_all(&handle.path);
    if let Ok(mut branch) = repo.find_branch(&handle.worktree_name, git2::BranchType::Local) {
        let _ = branch.delete();
    }
}

impl GitEngineState {
    /// Discards any ephemeral worktree left over from a previous run for these node ids,
    /// so every new pipeline execution starts each agent node from a clean sandbox.
    pub fn prepare_run(&self, repo_root: &Path, node_ids: &[String]) {
        let repo = match Repository::open(repo_root) {
            Ok(r) => r,
            Err(_) => return,
        };
        let mut worktrees = self.worktrees.lock().unwrap();
        for node_id in node_ids {
            if let Some(handle) = worktrees.remove(node_id) {
                prune_worktree(&repo, &handle);
            }
        }
    }

    /// Lazily creates (or reuses within the current run) an isolated git worktree for a
    /// node so its shell commands can never dirty the primary working branch.
    pub fn ensure_worktree(&self, repo_root: &Path, node_id: &str) -> Result<PathBuf, String> {
        {
            let worktrees = self.worktrees.lock().unwrap();
            if let Some(handle) = worktrees.get(node_id) {
                if handle.path.exists() {
                    return Ok(handle.path.clone());
                }
            }
        }

        let repo = Repository::open(repo_root).map_err(|e| e.to_string())?;
        let head_commit = repo
            .head()
            .and_then(|h| h.peel_to_commit())
            .map_err(|e| e.to_string())?;
        let base_commit = head_commit.id().to_string();

        let seq = WORKTREE_SEQ.fetch_add(1, Ordering::SeqCst);
        let worktree_name = format!("agent-{}-{}-{}", sanitize(node_id), timestamp_millis(), seq);
        let wt_root = std::env::temp_dir().join("central-worktrees");
        std::fs::create_dir_all(&wt_root).map_err(|e| e.to_string())?;
        let wt_path = wt_root.join(&worktree_name);

        repo.worktree(&worktree_name, &wt_path, None).map_err(|e| e.to_string())?;

        let mut worktrees = self.worktrees.lock().unwrap();
        worktrees.insert(
            node_id.to_string(),
            WorktreeHandle { worktree_name, path: wt_path.clone(), base_commit },
        );
        Ok(wt_path)
    }

    /// Stages and commits all pending edits inside a node's sandbox worktree, returning a
    /// diff stat summary for the "Agent Hand-off" cable badge. Returns `Ok(None)` when the
    /// node never touched a worktree or produced no file changes to hand off.
    pub fn commit_handoff(
        &self,
        node_id: &str,
        target_node_id: &str,
    ) -> Result<Option<HandoffResult>, String> {
        let (worktree_name, path, base_commit) = {
            let worktrees = self.worktrees.lock().unwrap();
            match worktrees.get(node_id) {
                Some(h) => (h.worktree_name.clone(), h.path.clone(), h.base_commit.clone()),
                None => return Ok(None),
            }
        };
        let _ = &worktree_name;

        let repo = Repository::open(&path).map_err(|e| e.to_string())?;

        let mut index = repo.index().map_err(|e| e.to_string())?;
        index
            .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
            .map_err(|e| e.to_string())?;
        index.write().map_err(|e| e.to_string())?;

        let base_oid = Oid::from_str(&base_commit).map_err(|e| e.to_string())?;
        let base_tree = repo.find_commit(base_oid).and_then(|c| c.tree()).map_err(|e| e.to_string())?;
        let new_tree_oid = index.write_tree().map_err(|e| e.to_string())?;
        let new_tree = repo.find_tree(new_tree_oid).map_err(|e| e.to_string())?;

        let diff = repo
            .diff_tree_to_tree(Some(&base_tree), Some(&new_tree), None)
            .map_err(|e| e.to_string())?;
        let stats = diff.stats().map_err(|e| e.to_string())?;

        if stats.files_changed() == 0 {
            return Ok(None);
        }

        let sig = repo
            .signature()
            .or_else(|_| Signature::now("Central Agent", "agent@central.local"))
            .map_err(|e| e.to_string())?;
        let parent = repo.head().and_then(|h| h.peel_to_commit()).map_err(|e| e.to_string())?;
        let message = format!("Agent Hand-off: {}", node_id);
        let commit_oid = repo
            .commit(Some("HEAD"), &sig, &sig, &message, &new_tree, &[&parent])
            .map_err(|e| e.to_string())?;

        Ok(Some(HandoffResult {
            node_id: node_id.to_string(),
            target_node_id: target_node_id.to_string(),
            commit_sha: commit_oid.to_string(),
            insertions: stats.insertions(),
            deletions: stats.deletions(),
            files_changed: stats.files_changed(),
        }))
    }

    /// Snapshot of every ephemeral worktree currently tracked, for the Deployments HUD.
    pub fn list_worktrees(&self) -> Vec<WorktreeInfo> {
        let worktrees = self.worktrees.lock().unwrap();
        worktrees
            .iter()
            .map(|(node_id, handle)| {
                let head_commit = head_commit_sha(&handle.path).unwrap_or_else(|| handle.base_commit.clone());
                WorktreeInfo {
                    node_id: node_id.clone(),
                    worktree_name: handle.worktree_name.clone(),
                    path: handle.path.display().to_string(),
                    base_commit: handle.base_commit.clone(),
                    head_commit,
                }
            })
            .collect()
    }

    /// Hard-resets a node's sandbox worktree back to the commit it branched from, discarding
    /// any agent edits (including new untracked files). This only ever touches the node's own
    /// throwaway worktree, never the primary working branch, so it is safe to expose as a
    /// one-click UI action.
    pub fn rollback_worktree(&self, node_id: &str) -> Result<(), String> {
        let (path, base_commit) = {
            let worktrees = self.worktrees.lock().unwrap();
            let handle = worktrees
                .get(node_id)
                .ok_or_else(|| format!("No active worktree for node '{}'", node_id))?;
            (handle.path.clone(), handle.base_commit.clone())
        };

        let repo = Repository::open(&path).map_err(|e| e.to_string())?;
        let base_oid = Oid::from_str(&base_commit).map_err(|e| e.to_string())?;
        let commit = repo.find_commit(base_oid).map_err(|e| e.to_string())?;
        repo.reset(commit.as_object(), ResetType::Hard, None).map_err(|e| e.to_string())?;

        // `reset --hard` only rewinds tracked files; new files an agent created are
        // untracked, so sweep those away too to fully restore the base node state.
        let mut status_opts = git2::StatusOptions::new();
        status_opts.include_untracked(true).recurse_untracked_dirs(true);
        if let Ok(statuses) = repo.statuses(Some(&mut status_opts)) {
            for entry in statuses.iter() {
                if entry.status().contains(git2::Status::WT_NEW) {
                    if let Some(rel) = entry.path() {
                        let full = path.join(rel);
                        if full.is_dir() {
                            let _ = std::fs::remove_dir_all(&full);
                        } else {
                            let _ = std::fs::remove_file(&full);
                        }
                    }
                }
            }
        }

        Ok(())
    }
}

#[tauri::command]
pub fn list_active_worktrees(state: State<'_, GitEngineState>) -> Vec<WorktreeInfo> {
    state.list_worktrees()
}

#[tauri::command]
pub fn rollback_worktree(node_id: String, state: State<'_, GitEngineState>) -> Result<(), String> {
    state.rollback_worktree(&node_id)
}

/// Resolves the project root the graph runner and git engine operate against. `tauri dev`
/// runs with `src-tauri` as the working directory, so climb one level out of it.
pub fn resolve_repo_root() -> PathBuf {
    let mut dir = std::env::current_dir().unwrap_or_default();
    if dir.ends_with("src-tauri") {
        dir.pop();
    }
    dir
}

#[tauri::command]
pub fn get_repo_head() -> Result<RepoHeadInfo, String> {
    let repo = Repository::open(resolve_repo_root()).map_err(|e| e.to_string())?;
    let head = repo.head().map_err(|e| e.to_string())?;
    let branch = head.shorthand().unwrap_or("HEAD").to_string();
    let commit = head.peel_to_commit().map_err(|e| e.to_string())?;
    Ok(RepoHeadInfo { branch, commit_sha: commit.id().to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64 as TestSeq, Ordering as TestOrdering};

    static TEST_SEQ: TestSeq = TestSeq::new(0);

    // Builds a throwaway git repo with one commit so each test gets full isolation
    // without needing a shared fixture or an external tempfile crate dependency.
    fn init_test_repo() -> PathBuf {
        let seq = TEST_SEQ.fetch_add(1, TestOrdering::SeqCst);
        let dir = std::env::temp_dir().join(format!("central-git-engine-test-{}-{}", std::process::id(), seq));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let repo = Repository::init(&dir).unwrap();
        std::fs::write(dir.join("README.md"), "hello\n").unwrap();

        let mut index = repo.index().unwrap();
        index.add_path(Path::new("README.md")).unwrap();
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let sig = Signature::now("Test", "test@example.com").unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "initial commit", &tree, &[]).unwrap();

        dir
    }

    #[test]
    fn ensure_worktree_creates_isolated_sandbox() {
        let repo_root = init_test_repo();
        let state = GitEngineState::default();

        let wt_path = state.ensure_worktree(&repo_root, "node-1").unwrap();

        assert!(wt_path.exists());
        assert_ne!(wt_path, repo_root);
        assert!(Repository::open(&wt_path).is_ok());

        let _ = std::fs::remove_dir_all(&repo_root);
        let _ = std::fs::remove_dir_all(&wt_path);
    }

    #[test]
    fn ensure_worktree_reuses_existing_sandbox_within_a_run() {
        let repo_root = init_test_repo();
        let state = GitEngineState::default();

        let first = state.ensure_worktree(&repo_root, "node-1").unwrap();
        let second = state.ensure_worktree(&repo_root, "node-1").unwrap();

        assert_eq!(first, second);

        let _ = std::fs::remove_dir_all(&repo_root);
        let _ = std::fs::remove_dir_all(&first);
    }

    #[test]
    fn commit_handoff_produces_diff_stats_and_commit() {
        let repo_root = init_test_repo();
        let state = GitEngineState::default();

        let wt_path = state.ensure_worktree(&repo_root, "coder-1").unwrap();
        std::fs::write(wt_path.join("agent-output.txt"), "agent edit\n").unwrap();

        let result = state.commit_handoff("coder-1", "reviewer-1").unwrap();
        let result = result.expect("expected a handoff result since a file changed");

        assert_eq!(result.node_id, "coder-1");
        assert_eq!(result.target_node_id, "reviewer-1");
        assert_eq!(result.insertions, 1);
        assert_eq!(result.files_changed, 1);
        assert!(!result.commit_sha.is_empty());

        let _ = std::fs::remove_dir_all(&repo_root);
        let _ = std::fs::remove_dir_all(&wt_path);
    }

    #[test]
    fn commit_handoff_returns_none_when_nothing_changed() {
        let repo_root = init_test_repo();
        let state = GitEngineState::default();

        let wt_path = state.ensure_worktree(&repo_root, "coder-1").unwrap();
        let result = state.commit_handoff("coder-1", "reviewer-1").unwrap();

        assert!(result.is_none());

        let _ = std::fs::remove_dir_all(&repo_root);
        let _ = std::fs::remove_dir_all(&wt_path);
    }

    #[test]
    fn commit_handoff_returns_none_for_unknown_node() {
        let state = GitEngineState::default();
        let result = state.commit_handoff("ghost-node", "reviewer-1").unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn prepare_run_prunes_previous_worktree_for_node() {
        let repo_root = init_test_repo();
        let state = GitEngineState::default();

        let first = state.ensure_worktree(&repo_root, "node-1").unwrap();
        assert!(first.exists());

        state.prepare_run(&repo_root, &["node-1".to_string()]);
        assert!(!first.exists());
        assert!(state.list_worktrees().is_empty());

        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[test]
    fn rollback_worktree_discards_uncommitted_edits() {
        let repo_root = init_test_repo();
        let state = GitEngineState::default();

        let wt_path = state.ensure_worktree(&repo_root, "node-1").unwrap();
        std::fs::write(wt_path.join("scratch.txt"), "temporary\n").unwrap();
        assert!(wt_path.join("scratch.txt").exists());

        state.rollback_worktree("node-1").unwrap();

        assert!(!wt_path.join("scratch.txt").exists());

        let _ = std::fs::remove_dir_all(&repo_root);
        let _ = std::fs::remove_dir_all(&wt_path);
    }

    #[test]
    fn list_worktrees_reports_active_sandboxes() {
        let repo_root = init_test_repo();
        let state = GitEngineState::default();

        state.ensure_worktree(&repo_root, "node-1").unwrap();
        let listed = state.list_worktrees();

        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].node_id, "node-1");

        for wt in &listed {
            let _ = std::fs::remove_dir_all(&wt.path);
        }
        let _ = std::fs::remove_dir_all(&repo_root);
    }
}
