use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use git2::{IndexAddOption, Oid, Repository, ResetType, Signature, Status, StatusOptions};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GitFileStatus {
    Modified,
    Added,
    Untracked,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusEntry {
    pub path: String,
    pub status: GitFileStatus,
}

struct WorktreeHandle {
    worktree_name: String,
    path: PathBuf,
    base_commit: String,
}

// A single task's sandbox worktree within an orchestration run, checked out on its own
// `task/<id>` branch. Kept separate from the pipeline-node `worktrees` map above since task
// worktrees branch off the run's staging branch (not the project's HEAD) and are pruned/
// recreated per task rather than per whole run.
struct TaskWorktreeHandle {
    worktree_name: String,
    path: PathBuf,
}

/// How a workbench session's terminal is bound to git: run directly against the main
/// workspace, or in an isolated worktree checked out to an existing or brand-new branch.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WorkbenchBinding {
    Main,
    Existing { branch: String },
    New { branch: String },
}

// Set only for Existing/New bindings; None (and no worktree_name) for Main, which runs
// directly in the workspace with no sandbox to clean up.
struct WorkbenchBindingHandle {
    path: PathBuf,
    branch_name: Option<String>,
    // Whether this binding created its branch (New) and therefore owns its lifecycle, vs.
    // merely checking out a branch the user already had (Existing) that must survive Discard.
    owns_branch: bool,
    worktree_name: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PromoteResult {
    pub branch: String,
    pub merge_commit_sha: Option<String>,
    pub fast_forward: bool,
    pub up_to_date: bool,
}

// Worktrees are keyed by (project_id, node_id) rather than just node_id, so two projects
// running pipelines concurrently (or reusing the same node id across separate canvases) never
// share or clobber each other's sandbox state.
type WorktreeKey = (String, String);

#[derive(Default)]
pub struct GitEngineState {
    worktrees: Mutex<HashMap<WorktreeKey, WorktreeHandle>>,
    // Keyed by (project_id, session_id) — a workbench session's git binding, separate from
    // the ephemeral pipeline-node worktrees map above since sessions are long-lived and
    // persisted across app restarts rather than pruned at the start of every run.
    bindings: Mutex<HashMap<WorktreeKey, WorkbenchBindingHandle>>,
    // Keyed by (project_id, task_id) — an orchestration run's per-task sandbox worktrees.
    task_worktrees: Mutex<HashMap<WorktreeKey, TaskWorktreeHandle>>,
    // Keyed by project_id — the single shared worktree an orchestration run uses to check out
    // `central/staging` for running the project's test command against accumulated merges.
    staging_worktrees: Mutex<HashMap<String, PathBuf>>,
    // libgit2 isn't safe for concurrent mutating calls against the same on-disk repo — two
    // `git_worktree_add` calls racing to create the shared `.git/worktrees` directory can hand
    // one of them a raw `EEXIST` instead of treating it as already-there. Every method that
    // writes to a repo's refs/worktrees/index (as opposed to pure reads like `list_worktrees`)
    // takes this lock for its full duration, which serializes what the orchestrator's dispatcher
    // otherwise fires off in parallel (one `create_task_worktree` call per concurrently running
    // task) against the same repo.
    git_write_lock: Mutex<()>,
}

/// Name of the branch (and its per-project worktree) an orchestration run accumulates every
/// task's merged work onto before it's promoted to the project's main branch.
const STAGING_BRANCH: &str = "central/staging";
const STAGING_WORKTREE_NAME: &str = "central-staging";

const CENTRAL_GITIGNORE_ENTRY: &str = ".central/";

/// Ensures the project workspace's `.gitignore` excludes Central's own `.central/` scratch
/// directory (agent worktrees, memory, vault), creating the file if it doesn't exist yet.
/// Idempotent: never appends a duplicate entry on repeated runs.
fn ensure_central_gitignored(workspace: &Path) {
    let path = workspace.join(".gitignore");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let already_present = existing
        .lines()
        .any(|line| matches!(line.trim(), ".central/" | ".central"));
    if already_present {
        return;
    }

    let mut updated = existing;
    if !updated.is_empty() && !updated.ends_with('\n') {
        updated.push('\n');
    }
    updated.push_str(CENTRAL_GITIGNORE_ENTRY);
    updated.push('\n');
    let _ = std::fs::write(&path, updated);
}

// Monotonic counter guarantees unique worktree/branch names even when two nodes are
// prepared within the same millisecond.
static WORKTREE_SEQ: AtomicU64 = AtomicU64::new(0);

fn sanitize(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

fn timestamp_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
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

// Like `prune_worktree` but for a workbench session's binding, where the branch to delete
// (if any) is independent of the worktree's own name and may be intentionally left alone
// (an Existing-branch binding must survive Discard; only a New binding owns its branch).
fn prune_workbench_worktree(
    repo: &Repository,
    worktree_name: &str,
    path: &Path,
    branch_to_delete: Option<&str>,
) {
    if let Ok(wt) = repo.find_worktree(worktree_name) {
        let mut opts = git2::WorktreePruneOptions::new();
        opts.working_tree(true);
        let _ = wt.prune(Some(&mut opts));
    }
    let _ = std::fs::remove_dir_all(path);
    if let Some(branch_name) = branch_to_delete {
        if let Ok(mut branch) = repo.find_branch(branch_name, git2::BranchType::Local) {
            let _ = branch.delete();
        }
    }
}

// Prunes a worktree registration by name (git-level metadata plus its working directory),
// tolerating either half already being gone. Shared by staging and task worktree cleanup,
// which — unlike prune_worktree/prune_workbench_worktree above — never delete a branch here:
// callers that need the underlying branch gone (task retries, staging reset) do so themselves,
// since a worktree name and its branch name aren't always the same string in this module.
fn prune_named_worktree(repo: &Repository, worktree_name: &str, path: &Path) {
    if let Ok(wt) = repo.find_worktree(worktree_name) {
        let mut opts = git2::WorktreePruneOptions::new();
        opts.working_tree(true);
        let _ = wt.prune(Some(&mut opts));
    }
    let _ = std::fs::remove_dir_all(path);
}

// Merges `branch_name` into the repo's currently checked-out HEAD, in the main working
// directory. Shared by promote_session (a workbench session's branch) and
// promote_staging_to_main (an orchestration run's `central/staging` branch) since both are
// "merge this ref into whatever the user has checked out" with identical fast-forward/merge/
// conflict-abort semantics — they differ only in how the branch name is resolved.
fn merge_branch_into_head(repo_root: &Path, branch_name: &str) -> Result<PromoteResult, String> {
    let repo = Repository::open(repo_root).map_err(|e| e.to_string())?;
    let branch_commit = repo
        .find_branch(branch_name, git2::BranchType::Local)
        .and_then(|b| b.get().peel_to_commit())
        .map_err(|e| e.to_string())?;
    let annotated = repo
        .find_annotated_commit(branch_commit.id())
        .map_err(|e| e.to_string())?;

    let (analysis, _) = repo
        .merge_analysis(&[&annotated])
        .map_err(|e| e.to_string())?;

    if analysis.is_up_to_date() {
        return Ok(PromoteResult {
            branch: branch_name.to_string(),
            merge_commit_sha: None,
            fast_forward: false,
            up_to_date: true,
        });
    }

    if analysis.is_fast_forward() {
        let mut head_ref = repo.head().map_err(|e| e.to_string())?;
        let refname = head_ref
            .name()
            .ok_or("Cannot fast-forward a detached HEAD")?
            .to_string();
        head_ref
            .set_target(branch_commit.id(), "promote: fast-forward")
            .map_err(|e| e.to_string())?;
        repo.set_head(&refname).map_err(|e| e.to_string())?;
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .map_err(|e| e.to_string())?;
        return Ok(PromoteResult {
            branch: branch_name.to_string(),
            merge_commit_sha: Some(branch_commit.id().to_string()),
            fast_forward: true,
            up_to_date: false,
        });
    }

    repo.merge(&[&annotated], None, None)
        .map_err(|e| e.to_string())?;

    let mut index = repo.index().map_err(|e| e.to_string())?;
    if index.has_conflicts() {
        let head_commit = repo
            .head()
            .and_then(|h| h.peel_to_commit())
            .map_err(|e| e.to_string())?;
        let _ = repo.cleanup_state();
        repo.reset(head_commit.as_object(), ResetType::Hard, None)
            .map_err(|e| e.to_string())?;
        return Err(format!(
            "Merge conflict promoting '{}': resolve manually and retry",
            branch_name
        ));
    }

    let tree_oid = index.write_tree().map_err(|e| e.to_string())?;
    let tree = repo.find_tree(tree_oid).map_err(|e| e.to_string())?;
    let sig = repo
        .signature()
        .or_else(|_| Signature::now("Central", "central@local"))
        .map_err(|e| e.to_string())?;
    let head_commit = repo
        .head()
        .and_then(|h| h.peel_to_commit())
        .map_err(|e| e.to_string())?;
    let message = format!("Merge branch '{}'", branch_name);
    let commit_oid = repo
        .commit(
            Some("HEAD"),
            &sig,
            &sig,
            &message,
            &tree,
            &[&head_commit, &branch_commit],
        )
        .map_err(|e| e.to_string())?;
    repo.cleanup_state().map_err(|e| e.to_string())?;
    repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
        .map_err(|e| e.to_string())?;

    Ok(PromoteResult {
        branch: branch_name.to_string(),
        merge_commit_sha: Some(commit_oid.to_string()),
        fast_forward: false,
        up_to_date: false,
    })
}

impl GitEngineState {
    /// Discards any ephemeral worktree left over from a previous run for these node ids within
    /// a project, so every new pipeline execution starts each agent node from a clean sandbox.
    pub fn prepare_run(&self, project_id: &str, repo_root: &Path, node_ids: &[String]) {
        let _write_guard = self.git_write_lock.lock().unwrap();
        let repo = match Repository::open(repo_root) {
            Ok(r) => r,
            Err(_) => return,
        };
        let mut worktrees = self.worktrees.lock().unwrap();
        for node_id in node_ids {
            let key = (project_id.to_string(), node_id.clone());
            if let Some(handle) = worktrees.remove(&key) {
                prune_worktree(&repo, &handle);
            }
        }
    }

    /// Lazily creates (or reuses within the current run) an isolated git worktree for a node
    /// within a project's workspace, so its shell commands can never dirty the primary working
    /// branch. Lives at `<workspace>/.central/worktrees/<node-id>`, with `.central/` gitignored
    /// so the agent's own scratch state never shows up as pending changes in the main worktree.
    pub fn ensure_worktree(
        &self,
        project_id: &str,
        repo_root: &Path,
        node_id: &str,
    ) -> Result<PathBuf, String> {
        let _write_guard = self.git_write_lock.lock().unwrap();
        let key = (project_id.to_string(), node_id.to_string());
        {
            let worktrees = self.worktrees.lock().unwrap();
            if let Some(handle) = worktrees.get(&key) {
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

        ensure_central_gitignored(repo_root);

        let seq = WORKTREE_SEQ.fetch_add(1, Ordering::SeqCst);
        let worktree_name = format!("agent-{}-{}-{}", sanitize(node_id), timestamp_millis(), seq);
        let wt_path = repo_root
            .join(".central")
            .join("worktrees")
            .join(sanitize(node_id));
        if let Some(parent) = wt_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        if wt_path.exists() {
            // Leftover from a crashed run that `prepare_run` never got a chance to prune;
            // `repo.worktree` refuses to create into an already-existing directory.
            let _ = std::fs::remove_dir_all(&wt_path);
        }

        repo.worktree(&worktree_name, &wt_path, None)
            .map_err(|e| e.to_string())?;

        let mut worktrees = self.worktrees.lock().unwrap();
        worktrees.insert(
            key,
            WorktreeHandle {
                worktree_name,
                path: wt_path.clone(),
                base_commit,
            },
        );
        Ok(wt_path)
    }

    /// Stages and commits all pending edits inside a node's sandbox worktree, returning a
    /// diff stat summary for the "Agent Hand-off" cable badge. Returns `Ok(None)` when the
    /// node never touched a worktree or produced no file changes to hand off.
    pub fn commit_handoff(
        &self,
        project_id: &str,
        node_id: &str,
        target_node_id: &str,
    ) -> Result<Option<HandoffResult>, String> {
        let _write_guard = self.git_write_lock.lock().unwrap();
        let (worktree_name, path, base_commit) = {
            let worktrees = self.worktrees.lock().unwrap();
            match worktrees.get(&(project_id.to_string(), node_id.to_string())) {
                Some(h) => (
                    h.worktree_name.clone(),
                    h.path.clone(),
                    h.base_commit.clone(),
                ),
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
        let base_tree = repo
            .find_commit(base_oid)
            .and_then(|c| c.tree())
            .map_err(|e| e.to_string())?;
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
        let parent = repo
            .head()
            .and_then(|h| h.peel_to_commit())
            .map_err(|e| e.to_string())?;
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

    /// Snapshot of every ephemeral worktree currently tracked for a project, for the
    /// Deployments HUD. Scoped so switching projects never shows another project's sandboxes.
    pub fn list_worktrees(&self, project_id: &str) -> Vec<WorktreeInfo> {
        let worktrees = self.worktrees.lock().unwrap();
        worktrees
            .iter()
            .filter(|((pid, _), _)| pid == project_id)
            .map(|((_, node_id), handle)| {
                let head_commit =
                    head_commit_sha(&handle.path).unwrap_or_else(|| handle.base_commit.clone());
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

    /// Resolves a node's sandbox worktree path, if one is currently active, for browsing its
    /// contents (see workspace_fs.rs's list_worktree_dir/read_worktree_file) without exposing
    /// the raw path map itself outside this module.
    pub fn worktree_path(&self, project_id: &str, node_id: &str) -> Option<PathBuf> {
        let worktrees = self.worktrees.lock().unwrap();
        worktrees
            .get(&(project_id.to_string(), node_id.to_string()))
            .map(|handle| handle.path.clone())
    }

    /// Hard-resets a node's sandbox worktree back to the commit it branched from, discarding
    /// any agent edits (including new untracked files). This only ever touches the node's own
    /// throwaway worktree, never the primary working branch, so it is safe to expose as a
    /// one-click UI action.
    pub fn rollback_worktree(&self, project_id: &str, node_id: &str) -> Result<(), String> {
        let _write_guard = self.git_write_lock.lock().unwrap();
        let (path, base_commit) = {
            let worktrees = self.worktrees.lock().unwrap();
            let handle = worktrees
                .get(&(project_id.to_string(), node_id.to_string()))
                .ok_or_else(|| format!("No active worktree for node '{}'", node_id))?;
            (handle.path.clone(), handle.base_commit.clone())
        };

        let repo = Repository::open(&path).map_err(|e| e.to_string())?;
        let base_oid = Oid::from_str(&base_commit).map_err(|e| e.to_string())?;
        let commit = repo.find_commit(base_oid).map_err(|e| e.to_string())?;
        repo.reset(commit.as_object(), ResetType::Hard, None)
            .map_err(|e| e.to_string())?;

        // `reset --hard` only rewinds tracked files; new files an agent created are
        // untracked, so sweep those away too to fully restore the base node state.
        let mut status_opts = git2::StatusOptions::new();
        status_opts
            .include_untracked(true)
            .recurse_untracked_dirs(true);
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

    /// Resolves (creating if needed) the working directory a workbench session's terminal
    /// should run in for the given binding. Idempotent across app restarts: a Main binding
    /// always resolves to the workspace root, and an Existing/New binding reuses whatever
    /// worktree already exists on disk at `<repo_root>/.central/workbench/<session_id>`
    /// rather than recreating it, since the on-disk worktree (and its underlying git metadata)
    /// outlives this in-memory map across process restarts.
    pub fn ensure_workbench_binding(
        &self,
        project_id: &str,
        repo_root: &Path,
        session_id: &str,
        binding: &WorkbenchBinding,
    ) -> Result<PathBuf, String> {
        let _write_guard = self.git_write_lock.lock().unwrap();
        let key = (project_id.to_string(), session_id.to_string());

        if matches!(binding, WorkbenchBinding::Main) {
            let mut bindings = self.bindings.lock().unwrap();
            bindings.insert(
                key,
                WorkbenchBindingHandle {
                    path: repo_root.to_path_buf(),
                    branch_name: None,
                    owns_branch: false,
                    worktree_name: None,
                },
            );
            return Ok(repo_root.to_path_buf());
        }

        let (branch_name, owns_branch) = match binding {
            WorkbenchBinding::Existing { branch } => (branch.clone(), false),
            WorkbenchBinding::New { branch } => (branch.clone(), true),
            WorkbenchBinding::Main => unreachable!("handled above"),
        };

        let worktree_name = sanitize(session_id);
        let wt_path = repo_root
            .join(".central")
            .join("workbench")
            .join(&worktree_name);

        // Already bound and still present on disk (e.g. a session restored after an app
        // restart) — nothing left to do.
        if wt_path.exists() {
            let mut bindings = self.bindings.lock().unwrap();
            bindings.insert(
                key,
                WorkbenchBindingHandle {
                    path: wt_path.clone(),
                    branch_name: Some(branch_name),
                    owns_branch,
                    worktree_name: Some(worktree_name),
                },
            );
            return Ok(wt_path);
        }

        let repo = Repository::open(repo_root).map_err(|e| e.to_string())?;
        ensure_central_gitignored(repo_root);

        if let Some(parent) = wt_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }

        if owns_branch {
            let head_commit = repo
                .head()
                .and_then(|h| h.peel_to_commit())
                .map_err(|e| e.to_string())?;
            repo.branch(&branch_name, &head_commit, false)
                .map_err(|e| e.to_string())?;
        }

        let branch_ref = repo
            .find_branch(&branch_name, git2::BranchType::Local)
            .map_err(|e| e.to_string())?
            .into_reference();
        let mut wt_opts = git2::WorktreeAddOptions::new();
        wt_opts.reference(Some(&branch_ref));
        repo.worktree(&worktree_name, &wt_path, Some(&wt_opts))
            .map_err(|e| e.to_string())?;

        let mut bindings = self.bindings.lock().unwrap();
        bindings.insert(
            key,
            WorkbenchBindingHandle {
                path: wt_path.clone(),
                branch_name: Some(branch_name),
                owns_branch,
                worktree_name: Some(worktree_name),
            },
        );
        Ok(wt_path)
    }

    /// Merges a workbench session's bound branch into the main workspace's currently checked
    /// out branch (HEAD). Fast-forwards when possible; otherwise creates a merge commit. On
    /// conflict, aborts cleanly (resets the workspace back to HEAD, no partial merge state
    /// left behind) and returns an error rather than attempting any auto-resolution.
    pub fn promote_session(
        &self,
        project_id: &str,
        repo_root: &Path,
        session_id: &str,
    ) -> Result<PromoteResult, String> {
        let _write_guard = self.git_write_lock.lock().unwrap();
        let branch_name = {
            let bindings = self.bindings.lock().unwrap();
            bindings
                .get(&(project_id.to_string(), session_id.to_string()))
                .and_then(|h| h.branch_name.clone())
                .ok_or_else(|| "Session has no branch to promote".to_string())?
        };
        merge_branch_into_head(repo_root, &branch_name)
    }

    /// Resets an orchestration run's shared `central/staging` branch to the project's current
    /// HEAD, sweeping away any staging worktree/branch and task worktrees/branches left over
    /// from a previous run. Called once at the start of every new run so tasks always branch
    /// off a clean, current base.
    pub fn reset_staging(&self, project_id: &str, repo_root: &Path) -> Result<(), String> {
        let _write_guard = self.git_write_lock.lock().unwrap();
        let repo = Repository::open(repo_root).map_err(|e| e.to_string())?;
        let head_commit = repo
            .head()
            .and_then(|h| h.peel_to_commit())
            .map_err(|e| e.to_string())?;

        if let Some(path) = self.staging_worktrees.lock().unwrap().remove(project_id) {
            prune_named_worktree(&repo, STAGING_WORKTREE_NAME, &path);
        } else if let Ok(wt) = repo.find_worktree(STAGING_WORKTREE_NAME) {
            // Leftover from a crashed previous run this in-memory map never learned about.
            let mut opts = git2::WorktreePruneOptions::new();
            opts.working_tree(true);
            let _ = wt.prune(Some(&mut opts));
        }

        // Sweep any task worktrees/branches left over from a previous run for this project.
        {
            let mut task_worktrees = self.task_worktrees.lock().unwrap();
            task_worktrees.retain(|(pid, _), handle| {
                if pid != project_id {
                    return true;
                }
                prune_named_worktree(&repo, &handle.worktree_name, &handle.path);
                false
            });
        }
        if let Ok(branches) = repo.branches(Some(git2::BranchType::Local)) {
            let stale: Vec<String> = branches
                .flatten()
                .filter_map(|(b, _)| b.name().ok().flatten().map(|n| n.to_string()))
                .filter(|n| n.starts_with("task/"))
                .collect();
            for name in stale {
                if let Ok(mut b) = repo.find_branch(&name, git2::BranchType::Local) {
                    let _ = b.delete();
                }
            }
        }
        let _ = std::fs::remove_dir_all(
            repo_root
                .join(".central")
                .join("orchestration")
                .join("tasks"),
        );

        if let Ok(mut b) = repo.find_branch(STAGING_BRANCH, git2::BranchType::Local) {
            let _ = b.delete();
        }
        repo.branch(STAGING_BRANCH, &head_commit, true)
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Lazily creates (recreating if this task already had one from a bounced retry) an
    /// isolated worktree for a task on its own `task/<id>` branch, branched off the run's
    /// current `central/staging` tip. `reset_staging` must have run first.
    pub fn create_task_worktree(
        &self,
        project_id: &str,
        repo_root: &Path,
        task_id: &str,
    ) -> Result<PathBuf, String> {
        let _write_guard = self.git_write_lock.lock().unwrap();
        let repo = Repository::open(repo_root).map_err(|e| e.to_string())?;
        let staging_commit = repo
            .find_branch(STAGING_BRANCH, git2::BranchType::Local)
            .and_then(|b| b.get().peel_to_commit())
            .map_err(|e| {
                format!(
                    "'{}' branch not found; reset_staging must run before create_task_worktree ({})",
                    STAGING_BRANCH, e
                )
            })?;

        let key = (project_id.to_string(), task_id.to_string());
        if let Some(old) = self.task_worktrees.lock().unwrap().remove(&key) {
            prune_named_worktree(&repo, &old.worktree_name, &old.path);
        }

        let branch_name = format!("task/{}", task_id);
        if let Ok(mut b) = repo.find_branch(&branch_name, git2::BranchType::Local) {
            let _ = b.delete();
        }
        repo.branch(&branch_name, &staging_commit, true)
            .map_err(|e| e.to_string())?;

        ensure_central_gitignored(repo_root);
        let wt_path = repo_root
            .join(".central")
            .join("orchestration")
            .join("tasks")
            .join(sanitize(task_id));
        if let Some(parent) = wt_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        if wt_path.exists() {
            let _ = std::fs::remove_dir_all(&wt_path);
        }

        // Unique worktree name (distinct from the stable `task/<id>` branch name) so a bounced
        // retry's new registration never collides with a not-yet-pruned previous one.
        let seq = WORKTREE_SEQ.fetch_add(1, Ordering::SeqCst);
        let worktree_name = format!("task-{}-{}-{}", sanitize(task_id), timestamp_millis(), seq);
        let branch_ref = repo
            .find_branch(&branch_name, git2::BranchType::Local)
            .map_err(|e| e.to_string())?
            .into_reference();
        let mut wt_opts = git2::WorktreeAddOptions::new();
        wt_opts.reference(Some(&branch_ref));
        repo.worktree(&worktree_name, &wt_path, Some(&wt_opts))
            .map_err(|e| e.to_string())?;

        self.task_worktrees.lock().unwrap().insert(
            key,
            TaskWorktreeHandle {
                worktree_name,
                path: wt_path.clone(),
            },
        );
        Ok(wt_path)
    }

    /// Resolves a task's active sandbox worktree path, if any, for browsing its contents.
    pub fn task_worktree_path(&self, project_id: &str, task_id: &str) -> Option<PathBuf> {
        self.task_worktrees
            .lock()
            .unwrap()
            .get(&(project_id.to_string(), task_id.to_string()))
            .map(|handle| handle.path.clone())
    }

    /// Merges a task's `task/<id>` branch into the run's `central/staging` branch without ever
    /// touching a working directory (git2's `merge_commits` operates purely on the object
    /// database), so this can run concurrently with other tasks still executing in their own
    /// worktrees. Fast-forwards when possible; otherwise synthesizes a merge commit. On
    /// conflict, returns an error naming the conflicted paths and leaves `central/staging`
    /// untouched — no partial merge state to clean up since nothing was written to disk.
    pub fn merge_task_into_staging(
        &self,
        _project_id: &str,
        repo_root: &Path,
        task_id: &str,
    ) -> Result<(), String> {
        let _write_guard = self.git_write_lock.lock().unwrap();
        let repo = Repository::open(repo_root).map_err(|e| e.to_string())?;
        let staging_branch = repo
            .find_branch(STAGING_BRANCH, git2::BranchType::Local)
            .map_err(|e| e.to_string())?;
        let staging_ref = staging_branch.get();
        let staging_refname = staging_ref
            .name()
            .ok_or("central/staging ref has no name")?
            .to_string();
        let staging_commit = staging_ref.peel_to_commit().map_err(|e| e.to_string())?;

        let branch_name = format!("task/{}", task_id);
        let task_commit = repo
            .find_branch(&branch_name, git2::BranchType::Local)
            .and_then(|b| b.get().peel_to_commit())
            .map_err(|e| e.to_string())?;

        let annotated = repo
            .find_annotated_commit(task_commit.id())
            .map_err(|e| e.to_string())?;
        let (analysis, _) = repo
            .merge_analysis_for_ref(staging_ref, &[&annotated])
            .map_err(|e| e.to_string())?;

        if analysis.is_up_to_date() {
            return Ok(());
        }

        if analysis.is_fast_forward() {
            repo.reference(
                &staging_refname,
                task_commit.id(),
                true,
                &format!("orchestration: fast-forward merge {}", branch_name),
            )
            .map_err(|e| e.to_string())?;
            return Ok(());
        }

        let mut index = repo
            .merge_commits(&staging_commit, &task_commit, None)
            .map_err(|e| e.to_string())?;

        if index.has_conflicts() {
            let paths: Vec<String> = index
                .conflicts()
                .map_err(|e| e.to_string())?
                .filter_map(|c| c.ok())
                .filter_map(|c| {
                    c.our
                        .or(c.their)
                        .or(c.ancestor)
                        .and_then(|e| String::from_utf8(e.path).ok())
                })
                .collect();
            return Err(format!(
                "Merge conflict merging {} into {}: {}",
                branch_name,
                STAGING_BRANCH,
                paths.join(", ")
            ));
        }

        let tree_oid = index.write_tree_to(&repo).map_err(|e| e.to_string())?;
        let tree = repo.find_tree(tree_oid).map_err(|e| e.to_string())?;
        let sig = repo
            .signature()
            .or_else(|_| Signature::now("Central Orchestrator", "orchestrator@central.local"))
            .map_err(|e| e.to_string())?;
        let message = format!("Merge {} into {}", branch_name, STAGING_BRANCH);
        repo.commit(
            Some(&staging_refname),
            &sig,
            &sig,
            &message,
            &tree,
            &[&staging_commit, &task_commit],
        )
        .map_err(|e| e.to_string())?;

        Ok(())
    }

    /// Ensures a working-directory checkout of the run's current `central/staging` tip exists
    /// (creating it on first use, or fast-checking-out to whatever `central/staging` now points
    /// at on reuse), for running the project's configured test command against accumulated
    /// merges.
    pub fn refresh_staging_worktree(
        &self,
        project_id: &str,
        repo_root: &Path,
    ) -> Result<PathBuf, String> {
        let _write_guard = self.git_write_lock.lock().unwrap();
        {
            let staging = self.staging_worktrees.lock().unwrap();
            if let Some(path) = staging.get(project_id) {
                if path.exists() {
                    let wt_repo = Repository::open(path).map_err(|e| e.to_string())?;
                    wt_repo
                        .checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
                        .map_err(|e| e.to_string())?;
                    return Ok(path.clone());
                }
            }
        }

        let repo = Repository::open(repo_root).map_err(|e| e.to_string())?;
        ensure_central_gitignored(repo_root);
        let wt_path = repo_root
            .join(".central")
            .join("orchestration")
            .join("staging");
        if let Some(parent) = wt_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        if wt_path.exists() {
            let _ = std::fs::remove_dir_all(&wt_path);
        }
        let branch_ref = repo
            .find_branch(STAGING_BRANCH, git2::BranchType::Local)
            .map_err(|e| e.to_string())?
            .into_reference();
        let mut wt_opts = git2::WorktreeAddOptions::new();
        wt_opts.reference(Some(&branch_ref));
        repo.worktree(STAGING_WORKTREE_NAME, &wt_path, Some(&wt_opts))
            .map_err(|e| e.to_string())?;

        self.staging_worktrees
            .lock()
            .unwrap()
            .insert(project_id.to_string(), wt_path.clone());
        Ok(wt_path)
    }

    /// Merges the run's `central/staging` branch into the project's currently checked out
    /// branch (HEAD) — the human-gate confirmation and auto-if-green final step. Shares its
    /// fast-forward/merge/conflict-abort behavior with `promote_session`.
    pub fn promote_staging_to_main(
        &self,
        _project_id: &str,
        repo_root: &Path,
    ) -> Result<PromoteResult, String> {
        let _write_guard = self.git_write_lock.lock().unwrap();
        merge_branch_into_head(repo_root, STAGING_BRANCH)
    }

    /// Tears down a workbench session's git binding: prunes its worktree (Main bindings have
    /// none, so this is a no-op for them) and deletes the branch only if this binding created
    /// it (New) — an Existing-branch binding must leave the user's pre-existing branch intact.
    pub fn discard_workbench_binding(
        &self,
        project_id: &str,
        repo_root: &Path,
        session_id: &str,
    ) -> Result<(), String> {
        let _write_guard = self.git_write_lock.lock().unwrap();
        let handle = {
            let mut bindings = self.bindings.lock().unwrap();
            bindings.remove(&(project_id.to_string(), session_id.to_string()))
        };
        let Some(handle) = handle else { return Ok(()) };
        let Some(worktree_name) = handle.worktree_name else {
            return Ok(());
        };

        let repo = Repository::open(repo_root).map_err(|e| e.to_string())?;
        let branch_to_delete = if handle.owns_branch {
            handle.branch_name.as_deref()
        } else {
            None
        };
        prune_workbench_worktree(&repo, &worktree_name, &handle.path, branch_to_delete);
        Ok(())
    }
}

fn list_branches_at(repo_root: &Path) -> Result<Vec<String>, String> {
    let repo = Repository::open(repo_root).map_err(|e| e.to_string())?;
    let mut names = Vec::new();
    for entry in repo
        .branches(Some(git2::BranchType::Local))
        .map_err(|e| e.to_string())?
    {
        let (branch, _) = entry.map_err(|e| e.to_string())?;
        if let Some(name) = branch.name().map_err(|e| e.to_string())? {
            names.push(name.to_string());
        }
    }
    names.sort();
    Ok(names)
}

fn branch_diff_at(repo_root: &Path, branch: &str) -> Result<String, String> {
    let repo = Repository::open(repo_root).map_err(|e| e.to_string())?;
    let head_tree = repo
        .head()
        .and_then(|h| h.peel_to_tree())
        .map_err(|e| e.to_string())?;
    let branch_tree = repo
        .find_branch(branch, git2::BranchType::Local)
        .and_then(|b| b.get().peel_to_tree())
        .map_err(|e| e.to_string())?;

    let diff = repo
        .diff_tree_to_tree(Some(&head_tree), Some(&branch_tree), None)
        .map_err(|e| e.to_string())?;

    let mut patch = String::new();
    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        if matches!(line.origin(), '+' | '-' | ' ') {
            patch.push(line.origin());
        }
        patch.push_str(&String::from_utf8_lossy(line.content()));
        true
    })
    .map_err(|e| e.to_string())?;

    Ok(patch)
}

#[tauri::command]
pub fn list_branches(project_id: String, app: AppHandle) -> Result<Vec<String>, String> {
    let workspace = crate::project::resolve_project_workspace(&app, &project_id)?;
    list_branches_at(&workspace)
}

#[tauri::command]
pub fn get_branch_diff(
    project_id: String,
    branch: String,
    app: AppHandle,
) -> Result<String, String> {
    let workspace = crate::project::resolve_project_workspace(&app, &project_id)?;
    branch_diff_at(&workspace, &branch)
}

#[tauri::command]
pub fn bind_workbench_session(
    project_id: String,
    session_id: String,
    binding: WorkbenchBinding,
    app: AppHandle,
    state: State<'_, GitEngineState>,
) -> Result<String, String> {
    let workspace = crate::project::resolve_project_workspace(&app, &project_id)?;
    state
        .ensure_workbench_binding(&project_id, &workspace, &session_id, &binding)
        .map(|p| p.display().to_string())
}

#[tauri::command]
pub fn promote_workbench_session(
    project_id: String,
    session_id: String,
    app: AppHandle,
    state: State<'_, GitEngineState>,
) -> Result<PromoteResult, String> {
    let workspace = crate::project::resolve_project_workspace(&app, &project_id)?;
    state.promote_session(&project_id, &workspace, &session_id)
}

#[tauri::command]
pub fn discard_workbench_session(
    project_id: String,
    session_id: String,
    app: AppHandle,
    state: State<'_, GitEngineState>,
) -> Result<(), String> {
    let workspace = crate::project::resolve_project_workspace(&app, &project_id)?;
    state.discard_workbench_binding(&project_id, &workspace, &session_id)
}

#[tauri::command]
pub fn list_active_worktrees(
    project_id: String,
    state: State<'_, GitEngineState>,
) -> Vec<WorktreeInfo> {
    state.list_worktrees(&project_id)
}

#[tauri::command]
pub fn rollback_worktree(
    project_id: String,
    node_id: String,
    state: State<'_, GitEngineState>,
) -> Result<(), String> {
    state.rollback_worktree(&project_id, &node_id)
}

/// Resolves the project root the graph runner and git engine operate against: the
/// active project set via `set_active_project_path`, or (if none has been opened yet)
/// the dev fallback of climbing one level out of `src-tauri`, since `tauri dev` runs
/// with `src-tauri` as the working directory.
pub fn resolve_repo_root(app: &AppHandle) -> PathBuf {
    effective_repo_root(active_project_path(app))
}

fn active_project_path(app: &AppHandle) -> Option<PathBuf> {
    app.try_state::<crate::ProjectState>()?
        .0
        .lock()
        .unwrap()
        .clone()
}

// Pure and AppHandle-free so the override-vs-fallback branching can be unit tested directly.
fn effective_repo_root(active_project: Option<PathBuf>) -> PathBuf {
    active_project.unwrap_or_else(default_repo_root)
}

fn default_repo_root() -> PathBuf {
    let mut dir = std::env::current_dir().unwrap_or_default();
    if dir.ends_with("src-tauri") {
        dir.pop();
    }
    dir
}

#[tauri::command]
pub fn get_repo_head(project_id: String, app: AppHandle) -> Result<RepoHeadInfo, String> {
    let workspace = crate::project::resolve_project_workspace(&app, &project_id)?;
    let repo = Repository::open(workspace).map_err(|e| e.to_string())?;
    let head = repo.head().map_err(|e| e.to_string())?;
    let branch = head.shorthand().unwrap_or("HEAD").to_string();
    let commit = head.peel_to_commit().map_err(|e| e.to_string())?;
    Ok(RepoHeadInfo {
        branch,
        commit_sha: commit.id().to_string(),
    })
}

/// Renders the working tree's pending changes (staged + unstaged, against HEAD) as a unified
/// patch, for the Terminal Node's "Inject Git Diff" context action.
#[tauri::command]
pub fn get_git_diff(project_id: String, app: AppHandle) -> Result<String, String> {
    let workspace = crate::project::resolve_project_workspace(&app, &project_id)?;
    let repo = Repository::open(workspace).map_err(|e| e.to_string())?;
    let head_tree = repo
        .head()
        .and_then(|h| h.peel_to_tree())
        .map_err(|e| e.to_string())?;
    let diff = repo
        .diff_tree_to_workdir_with_index(Some(&head_tree), None)
        .map_err(|e| e.to_string())?;

    let mut patch = String::new();
    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        if matches!(line.origin(), '+' | '-' | ' ') {
            patch.push(line.origin());
        }
        patch.push_str(&String::from_utf8_lossy(line.content()));
        true
    })
    .map_err(|e| e.to_string())?;

    Ok(patch)
}

// Pure and AppHandle-free so it can be exercised directly in unit tests. The commit is looked
// up by sha across the whole repo, so it resolves even when it was made inside a node's
// ephemeral worktree — worktrees share the same object database as the main repo.
fn diff_for_commit(repo_root: &Path, sha: &str) -> Result<String, String> {
    let repo = Repository::open(repo_root).map_err(|e| e.to_string())?;
    let oid = Oid::from_str(sha).map_err(|e| e.to_string())?;
    let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
    let tree = commit.tree().map_err(|e| e.to_string())?;
    let parent_tree = commit.parent(0).and_then(|p| p.tree()).ok();

    let diff = repo
        .diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None)
        .map_err(|e| e.to_string())?;

    let mut patch = String::new();
    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        if matches!(line.origin(), '+' | '-' | ' ') {
            patch.push(line.origin());
        }
        patch.push_str(&String::from_utf8_lossy(line.content()));
        true
    })
    .map_err(|e| e.to_string())?;

    Ok(patch)
}

/// Renders a single commit's changes (against its first parent) as a unified patch, for the
/// cable diff-preview popover, fetched on demand when the user hovers the diff badge.
#[tauri::command]
pub fn get_diff_for_commit(
    project_id: String,
    sha: String,
    app: AppHandle,
) -> Result<String, String> {
    let workspace = crate::project::resolve_project_workspace(&app, &project_id)?;
    diff_for_commit(&workspace, &sha)
}

/// Classifies a git2 status bitset into the three buckets the files panel/editor tabs decorate
/// with. `WT_NEW` without `INDEX_NEW` is a plain untracked file; `INDEX_NEW` is staged-but-new
/// ("added"); anything else with a nonzero status (modified, deleted, renamed, typechanged, in
/// either the index or the working tree) is folded into "modified" since the UI only needs a
/// three-way distinction, not the full staged/unstaged matrix.
fn classify_status(status: Status) -> Option<GitFileStatus> {
    if status.is_wt_new() {
        Some(GitFileStatus::Untracked)
    } else if status.is_index_new() {
        Some(GitFileStatus::Added)
    } else if status.is_ignored() || status == Status::CURRENT {
        None
    } else {
        Some(GitFileStatus::Modified)
    }
}

// Pure and AppHandle-free so it can be exercised directly in unit tests against a tempdir repo.
fn git_status_for(workspace: &Path) -> Result<Vec<GitStatusEntry>, String> {
    let repo = Repository::open(workspace).map_err(|e| e.to_string())?;
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);
    let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.to_string())?;

    let mut entries = Vec::new();
    for entry in statuses.iter() {
        let Some(path) = entry.path() else { continue };
        if let Some(status) = classify_status(entry.status()) {
            entries.push(GitStatusEntry {
                path: path.to_string(),
                status,
            });
        }
    }
    Ok(entries)
}

/// Renders the workspace's git status (modified/added/untracked relative to HEAD) for the files
/// panel tree and editor tab decorations.
#[tauri::command]
pub fn get_git_status(project_id: String, app: AppHandle) -> Result<Vec<GitStatusEntry>, String> {
    let workspace = crate::project::resolve_project_workspace(&app, &project_id)?;
    git_status_for(&workspace)
}

// Pure and AppHandle-free so it can be exercised directly in unit tests. Returns `None` when the
// path didn't exist at HEAD (a new/untracked file), which the editor's diff-vs-HEAD toggle
// renders as an empty "before" side rather than an error.
fn file_at_head(workspace: &Path, relative: &str) -> Result<Option<String>, String> {
    let repo = Repository::open(workspace).map_err(|e| e.to_string())?;
    let head_tree = match repo.head().and_then(|h| h.peel_to_tree()) {
        Ok(tree) => tree,
        Err(_) => return Ok(None), // unborn HEAD (no commits yet)
    };
    let entry = match head_tree.get_path(Path::new(relative)) {
        Ok(entry) => entry,
        Err(_) => return Ok(None),
    };
    let object = entry.to_object(&repo).map_err(|e| e.to_string())?;
    let blob = object
        .as_blob()
        .ok_or_else(|| "Path is not a file at HEAD".to_string())?;
    String::from_utf8(blob.content().to_vec())
        .map(Some)
        .map_err(|_| "Cannot diff a binary file".to_string())
}

/// Fetches a file's content as of HEAD, for the editor's per-file diff-vs-HEAD toggle.
#[tauri::command]
pub fn get_file_at_head(
    project_id: String,
    path: String,
    app: AppHandle,
) -> Result<Option<String>, String> {
    let workspace = crate::project::resolve_project_workspace(&app, &project_id)?;
    file_at_head(&workspace, &path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64 as TestSeq, Ordering as TestOrdering};

    #[test]
    fn effective_repo_root_prefers_active_project_over_default() {
        let active = PathBuf::from("/tmp/some-other-project");
        assert_eq!(effective_repo_root(Some(active.clone())), active);
    }

    #[test]
    fn effective_repo_root_falls_back_to_default_when_no_project_is_active() {
        assert_eq!(effective_repo_root(None), default_repo_root());
    }

    static TEST_SEQ: TestSeq = TestSeq::new(0);

    // Builds a throwaway git repo with one commit so each test gets full isolation
    // without needing a shared fixture or an external tempfile crate dependency.
    fn init_test_repo() -> PathBuf {
        let seq = TEST_SEQ.fetch_add(1, TestOrdering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "central-git-engine-test-{}-{}",
            std::process::id(),
            seq
        ));
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
        repo.commit(Some("HEAD"), &sig, &sig, "initial commit", &tree, &[])
            .unwrap();

        dir
    }

    #[test]
    fn ensure_worktree_creates_isolated_sandbox() {
        let repo_root = init_test_repo();
        let state = GitEngineState::default();

        let wt_path = state
            .ensure_worktree("proj-a", &repo_root, "node-1")
            .unwrap();

        assert!(wt_path.exists());
        assert_ne!(wt_path, repo_root);
        assert!(Repository::open(&wt_path).is_ok());
        assert_eq!(
            wt_path,
            repo_root.join(".central").join("worktrees").join("node-1")
        );

        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[test]
    fn ensure_worktree_gitignores_the_central_scratch_dir() {
        let repo_root = init_test_repo();
        let state = GitEngineState::default();

        state
            .ensure_worktree("proj-a", &repo_root, "node-1")
            .unwrap();

        let gitignore = std::fs::read_to_string(repo_root.join(".gitignore")).unwrap();
        assert_eq!(
            gitignore
                .lines()
                .filter(|l| l.trim() == ".central/")
                .count(),
            1
        );

        // Running it again (e.g. a second node in the same project) must not duplicate
        // the entry.
        state
            .ensure_worktree("proj-a", &repo_root, "node-2")
            .unwrap();
        let gitignore_again = std::fs::read_to_string(repo_root.join(".gitignore")).unwrap();
        assert_eq!(
            gitignore_again
                .lines()
                .filter(|l| l.trim() == ".central/")
                .count(),
            1
        );

        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[test]
    fn ensure_worktree_preserves_existing_gitignore_content() {
        let repo_root = init_test_repo();
        std::fs::write(repo_root.join(".gitignore"), "node_modules/\n").unwrap();
        let state = GitEngineState::default();

        state
            .ensure_worktree("proj-a", &repo_root, "node-1")
            .unwrap();

        let gitignore = std::fs::read_to_string(repo_root.join(".gitignore")).unwrap();
        assert!(gitignore.contains("node_modules/"));
        assert!(gitignore.contains(".central/"));

        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[test]
    fn ensure_worktree_reuses_existing_sandbox_within_a_run() {
        let repo_root = init_test_repo();
        let state = GitEngineState::default();

        let first = state
            .ensure_worktree("proj-a", &repo_root, "node-1")
            .unwrap();
        let second = state
            .ensure_worktree("proj-a", &repo_root, "node-1")
            .unwrap();

        assert_eq!(first, second);

        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[test]
    fn ensure_worktree_isolates_state_across_projects_with_separate_roots() {
        let repo_a = init_test_repo();
        let repo_b = init_test_repo();
        let state = GitEngineState::default();

        // Same node id, two different projects with two different repo roots.
        let path_a = state.ensure_worktree("proj-a", &repo_a, "node-1").unwrap();
        let path_b = state.ensure_worktree("proj-b", &repo_b, "node-1").unwrap();

        assert_ne!(path_a, path_b);
        assert!(path_a.starts_with(&repo_a));
        assert!(path_b.starts_with(&repo_b));
        assert!(Repository::open(&path_a).is_ok());
        assert!(Repository::open(&path_b).is_ok());

        let _ = std::fs::remove_dir_all(&repo_a);
        let _ = std::fs::remove_dir_all(&repo_b);
    }

    #[test]
    fn commit_handoff_produces_diff_stats_and_commit() {
        let repo_root = init_test_repo();
        let state = GitEngineState::default();

        let wt_path = state
            .ensure_worktree("proj-a", &repo_root, "coder-1")
            .unwrap();
        std::fs::write(wt_path.join("agent-output.txt"), "agent edit\n").unwrap();

        let result = state
            .commit_handoff("proj-a", "coder-1", "reviewer-1")
            .unwrap();
        let result = result.expect("expected a handoff result since a file changed");

        assert_eq!(result.node_id, "coder-1");
        assert_eq!(result.target_node_id, "reviewer-1");
        assert_eq!(result.insertions, 1);
        assert_eq!(result.files_changed, 1);
        assert!(!result.commit_sha.is_empty());

        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[test]
    fn commit_handoff_returns_none_when_nothing_changed() {
        let repo_root = init_test_repo();
        let state = GitEngineState::default();

        state
            .ensure_worktree("proj-a", &repo_root, "coder-1")
            .unwrap();
        let result = state
            .commit_handoff("proj-a", "coder-1", "reviewer-1")
            .unwrap();

        assert!(result.is_none());

        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[test]
    fn commit_handoff_returns_none_for_unknown_node() {
        let state = GitEngineState::default();
        let result = state
            .commit_handoff("proj-a", "ghost-node", "reviewer-1")
            .unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn commit_handoff_scopes_to_project_even_with_shared_node_id() {
        let repo_a = init_test_repo();
        let repo_b = init_test_repo();
        let state = GitEngineState::default();

        let wt_a = state.ensure_worktree("proj-a", &repo_a, "coder-1").unwrap();
        state.ensure_worktree("proj-b", &repo_b, "coder-1").unwrap();
        std::fs::write(wt_a.join("agent-output.txt"), "agent edit\n").unwrap();

        // proj-b never touched its worktree, so its handoff for the same node id is a no-op...
        let result_b = state
            .commit_handoff("proj-b", "coder-1", "reviewer-1")
            .unwrap();
        assert!(result_b.is_none());

        // ...while proj-a's own edit still hands off correctly.
        let result_a = state
            .commit_handoff("proj-a", "coder-1", "reviewer-1")
            .unwrap()
            .expect("expected a handoff result since proj-a's worktree changed");
        assert_eq!(result_a.files_changed, 1);

        let _ = std::fs::remove_dir_all(&repo_a);
        let _ = std::fs::remove_dir_all(&repo_b);
    }

    #[test]
    fn diff_for_commit_renders_patch_for_handoff_commit_sha() {
        let repo_root = init_test_repo();
        let state = GitEngineState::default();

        let wt_path = state
            .ensure_worktree("proj-a", &repo_root, "coder-1")
            .unwrap();
        std::fs::write(wt_path.join("agent-output.txt"), "agent edit\n").unwrap();
        let result = state
            .commit_handoff("proj-a", "coder-1", "reviewer-1")
            .unwrap()
            .expect("expected a handoff result since a file changed");

        // Looked up from the main repo root, not the worktree it was committed in — proving
        // the shared object database assumption the popover fetch relies on.
        let patch = diff_for_commit(&repo_root, &result.commit_sha).unwrap();

        assert!(patch.contains("agent-output.txt"));
        assert!(patch.contains("+agent edit"));

        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[test]
    fn diff_for_commit_rejects_invalid_sha() {
        let repo_root = init_test_repo();
        let result = diff_for_commit(&repo_root, "not-a-real-sha");
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[test]
    fn prepare_run_prunes_previous_worktree_for_node() {
        let repo_root = init_test_repo();
        let state = GitEngineState::default();

        let first = state
            .ensure_worktree("proj-a", &repo_root, "node-1")
            .unwrap();
        assert!(first.exists());

        state.prepare_run("proj-a", &repo_root, &["node-1".to_string()]);
        assert!(!first.exists());
        assert!(state.list_worktrees("proj-a").is_empty());

        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[test]
    fn prepare_run_does_not_prune_another_projects_worktree() {
        let repo_a = init_test_repo();
        let repo_b = init_test_repo();
        let state = GitEngineState::default();

        let path_a = state.ensure_worktree("proj-a", &repo_a, "node-1").unwrap();
        let path_b = state.ensure_worktree("proj-b", &repo_b, "node-1").unwrap();

        state.prepare_run("proj-a", &repo_a, &["node-1".to_string()]);

        assert!(!path_a.exists());
        assert!(path_b.exists());
        assert_eq!(state.list_worktrees("proj-b").len(), 1);

        let _ = std::fs::remove_dir_all(&repo_a);
        let _ = std::fs::remove_dir_all(&repo_b);
    }

    #[test]
    fn rollback_worktree_discards_uncommitted_edits() {
        let repo_root = init_test_repo();
        let state = GitEngineState::default();

        let wt_path = state
            .ensure_worktree("proj-a", &repo_root, "node-1")
            .unwrap();
        std::fs::write(wt_path.join("scratch.txt"), "temporary\n").unwrap();
        assert!(wt_path.join("scratch.txt").exists());

        state.rollback_worktree("proj-a", "node-1").unwrap();

        assert!(!wt_path.join("scratch.txt").exists());

        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[test]
    fn rollback_worktree_rejects_wrong_project_id_for_shared_node_id() {
        let repo_a = init_test_repo();
        let repo_b = init_test_repo();
        let state = GitEngineState::default();

        state.ensure_worktree("proj-a", &repo_a, "node-1").unwrap();
        state.ensure_worktree("proj-b", &repo_b, "node-1").unwrap();

        // proj-a's own worktree rolls back fine...
        assert!(state.rollback_worktree("proj-a", "node-1").is_ok());
        // ...but a project id that never created this node's worktree does not reach into
        // another project's sandbox.
        assert!(state.rollback_worktree("proj-c", "node-1").is_err());

        let _ = std::fs::remove_dir_all(&repo_a);
        let _ = std::fs::remove_dir_all(&repo_b);
    }

    #[test]
    fn list_worktrees_reports_active_sandboxes() {
        let repo_root = init_test_repo();
        let state = GitEngineState::default();

        state
            .ensure_worktree("proj-a", &repo_root, "node-1")
            .unwrap();
        let listed = state.list_worktrees("proj-a");

        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].node_id, "node-1");

        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[test]
    fn worktree_path_returns_active_sandbox_path() {
        let repo_root = init_test_repo();
        let state = GitEngineState::default();

        let path = state
            .ensure_worktree("proj-a", &repo_root, "node-1")
            .unwrap();

        assert_eq!(state.worktree_path("proj-a", "node-1"), Some(path));

        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[test]
    fn worktree_path_returns_none_for_unknown_node() {
        let state = GitEngineState::default();
        assert_eq!(state.worktree_path("proj-a", "no-such-node"), None);
    }

    #[test]
    fn list_worktrees_scopes_to_project() {
        let repo_a = init_test_repo();
        let repo_b = init_test_repo();
        let state = GitEngineState::default();

        state.ensure_worktree("proj-a", &repo_a, "node-1").unwrap();
        state.ensure_worktree("proj-b", &repo_b, "node-2").unwrap();

        let listed_a = state.list_worktrees("proj-a");
        assert_eq!(listed_a.len(), 1);
        assert_eq!(listed_a[0].node_id, "node-1");

        let listed_b = state.list_worktrees("proj-b");
        assert_eq!(listed_b.len(), 1);
        assert_eq!(listed_b[0].node_id, "node-2");

        let _ = std::fs::remove_dir_all(&repo_a);
        let _ = std::fs::remove_dir_all(&repo_b);
    }

    #[test]
    fn git_status_reports_untracked_added_and_modified() {
        let repo_root = init_test_repo();

        // Modify the committed file.
        std::fs::write(repo_root.join("README.md"), "changed\n").unwrap();
        // Stage a new file (added).
        std::fs::write(repo_root.join("staged.txt"), "staged\n").unwrap();
        {
            let repo = Repository::open(&repo_root).unwrap();
            let mut index = repo.index().unwrap();
            index.add_path(Path::new("staged.txt")).unwrap();
            index.write().unwrap();
        }
        // Leave an untracked file alone.
        std::fs::write(repo_root.join("scratch.txt"), "scratch\n").unwrap();

        let mut entries = git_status_for(&repo_root).unwrap();
        entries.sort_by(|a, b| a.path.cmp(&b.path));

        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].path, "README.md");
        assert_eq!(entries[0].status, GitFileStatus::Modified);
        assert_eq!(entries[1].path, "scratch.txt");
        assert_eq!(entries[1].status, GitFileStatus::Untracked);
        assert_eq!(entries[2].path, "staged.txt");
        assert_eq!(entries[2].status, GitFileStatus::Added);

        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[test]
    fn git_status_omits_clean_files() {
        let repo_root = init_test_repo();
        let entries = git_status_for(&repo_root).unwrap();
        assert!(entries.is_empty());
        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[test]
    fn file_at_head_returns_committed_content() {
        let repo_root = init_test_repo();
        let content = file_at_head(&repo_root, "README.md").unwrap();
        assert_eq!(content, Some("hello\n".to_string()));
        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[test]
    fn file_at_head_returns_none_for_new_file() {
        let repo_root = init_test_repo();
        std::fs::write(repo_root.join("new.txt"), "new\n").unwrap();
        let content = file_at_head(&repo_root, "new.txt").unwrap();
        assert_eq!(content, None);
        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[test]
    fn ensure_workbench_binding_main_resolves_to_repo_root() {
        let repo_root = init_test_repo();
        let state = GitEngineState::default();

        let path = state
            .ensure_workbench_binding("proj-a", &repo_root, "sess-1", &WorkbenchBinding::Main)
            .unwrap();

        assert_eq!(path, repo_root);
        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[test]
    fn ensure_workbench_binding_new_creates_worktree_and_branch() {
        let repo_root = init_test_repo();
        let state = GitEngineState::default();

        let path = state
            .ensure_workbench_binding(
                "proj-a",
                &repo_root,
                "sess-1",
                &WorkbenchBinding::New {
                    branch: "feature-x".to_string(),
                },
            )
            .unwrap();

        assert!(path.exists());
        assert_ne!(path, repo_root);
        let repo = Repository::open(&repo_root).unwrap();
        assert!(repo
            .find_branch("feature-x", git2::BranchType::Local)
            .is_ok());

        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[test]
    fn ensure_workbench_binding_existing_checks_out_current_branch() {
        let repo_root = init_test_repo();
        let repo = Repository::open(&repo_root).unwrap();
        let head_commit = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("already-here", &head_commit, false).unwrap();
        let state = GitEngineState::default();

        let path = state
            .ensure_workbench_binding(
                "proj-a",
                &repo_root,
                "sess-1",
                &WorkbenchBinding::Existing {
                    branch: "already-here".to_string(),
                },
            )
            .unwrap();

        assert!(path.exists());
        let wt_repo = Repository::open(&path).unwrap();
        assert_eq!(wt_repo.head().unwrap().shorthand(), Some("already-here"));

        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[test]
    fn ensure_workbench_binding_reuses_worktree_across_a_fresh_state_restart() {
        let repo_root = init_test_repo();
        let first_state = GitEngineState::default();
        let binding = WorkbenchBinding::New {
            branch: "restart-branch".to_string(),
        };
        let first_path = first_state
            .ensure_workbench_binding("proj-a", &repo_root, "sess-1", &binding)
            .unwrap();

        // Simulate an app restart: a brand new GitEngineState with an empty in-memory map,
        // but the worktree directory from before still exists on disk.
        let second_state = GitEngineState::default();
        let second_path = second_state
            .ensure_workbench_binding("proj-a", &repo_root, "sess-1", &binding)
            .unwrap();

        assert_eq!(first_path, second_path);
        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[test]
    fn list_branches_at_returns_sorted_local_branch_names() {
        let repo_root = init_test_repo();
        let repo = Repository::open(&repo_root).unwrap();
        let head_commit = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("zeta", &head_commit, false).unwrap();
        repo.branch("alpha", &head_commit, false).unwrap();

        // Don't assume a specific default branch name (git config-dependent) — just check
        // the two branches we created are present, correctly sorted around it.
        let branches = list_branches_at(&repo_root).unwrap();
        assert!(branches.windows(2).all(|w| w[0] <= w[1]));
        assert!(branches.contains(&"alpha".to_string()));
        assert!(branches.contains(&"zeta".to_string()));
        assert_eq!(branches.len(), 3);

        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[test]
    fn branch_diff_at_renders_patch_against_head() {
        let repo_root = init_test_repo();
        let state = GitEngineState::default();
        let wt_path = state
            .ensure_workbench_binding(
                "proj-a",
                &repo_root,
                "sess-1",
                &WorkbenchBinding::New {
                    branch: "diffable".to_string(),
                },
            )
            .unwrap();
        std::fs::write(wt_path.join("new.txt"), "hello\n").unwrap();
        let wt_repo = Repository::open(&wt_path).unwrap();
        let mut index = wt_repo.index().unwrap();
        index.add_path(Path::new("new.txt")).unwrap();
        index.write().unwrap();
        let tree = wt_repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = Signature::now("Test", "test@example.com").unwrap();
        let parent = wt_repo.head().unwrap().peel_to_commit().unwrap();
        wt_repo
            .commit(Some("HEAD"), &sig, &sig, "add file", &tree, &[&parent])
            .unwrap();

        let diff = branch_diff_at(&repo_root, "diffable").unwrap();
        assert!(diff.contains("new.txt"));
        assert!(diff.contains("+hello"));

        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[test]
    fn promote_session_fast_forwards_when_main_has_no_new_commits() {
        let repo_root = init_test_repo();
        let state = GitEngineState::default();
        let wt_path = state
            .ensure_workbench_binding(
                "proj-a",
                &repo_root,
                "sess-1",
                &WorkbenchBinding::New {
                    branch: "ff-branch".to_string(),
                },
            )
            .unwrap();
        std::fs::write(wt_path.join("added.txt"), "x\n").unwrap();
        let wt_repo = Repository::open(&wt_path).unwrap();
        let mut index = wt_repo.index().unwrap();
        index.add_path(Path::new("added.txt")).unwrap();
        index.write().unwrap();
        let tree = wt_repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = Signature::now("Test", "test@example.com").unwrap();
        let parent = wt_repo.head().unwrap().peel_to_commit().unwrap();
        wt_repo
            .commit(Some("HEAD"), &sig, &sig, "add file", &tree, &[&parent])
            .unwrap();

        let result = state
            .promote_session("proj-a", &repo_root, "sess-1")
            .unwrap();
        assert!(result.fast_forward);
        assert!(!result.up_to_date);
        assert!(result.merge_commit_sha.is_some());
        assert!(repo_root.join("added.txt").exists());

        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[test]
    fn promote_session_reports_up_to_date_when_branch_has_no_new_commits() {
        let repo_root = init_test_repo();
        let state = GitEngineState::default();
        state
            .ensure_workbench_binding(
                "proj-a",
                &repo_root,
                "sess-1",
                &WorkbenchBinding::New {
                    branch: "empty-branch".to_string(),
                },
            )
            .unwrap();

        let result = state
            .promote_session("proj-a", &repo_root, "sess-1")
            .unwrap();
        assert!(result.up_to_date);
        assert!(!result.fast_forward);
        assert!(result.merge_commit_sha.is_none());

        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[test]
    fn promote_session_creates_merge_commit_when_main_has_diverged() {
        let repo_root = init_test_repo();
        let state = GitEngineState::default();
        let wt_path = state
            .ensure_workbench_binding(
                "proj-a",
                &repo_root,
                "sess-1",
                &WorkbenchBinding::New {
                    branch: "diverged".to_string(),
                },
            )
            .unwrap();

        // Session branch adds its own file.
        std::fs::write(wt_path.join("from-session.txt"), "s\n").unwrap();
        let wt_repo = Repository::open(&wt_path).unwrap();
        let mut wt_index = wt_repo.index().unwrap();
        wt_index.add_path(Path::new("from-session.txt")).unwrap();
        wt_index.write().unwrap();
        let wt_tree = wt_repo.find_tree(wt_index.write_tree().unwrap()).unwrap();
        let sig = Signature::now("Test", "test@example.com").unwrap();
        let wt_parent = wt_repo.head().unwrap().peel_to_commit().unwrap();
        wt_repo
            .commit(
                Some("HEAD"),
                &sig,
                &sig,
                "session commit",
                &wt_tree,
                &[&wt_parent],
            )
            .unwrap();

        // Main workspace independently gains its own, non-conflicting commit.
        std::fs::write(repo_root.join("from-main.txt"), "m\n").unwrap();
        let main_repo = Repository::open(&repo_root).unwrap();
        let mut main_index = main_repo.index().unwrap();
        main_index.add_path(Path::new("from-main.txt")).unwrap();
        main_index.write().unwrap();
        let main_tree = main_repo
            .find_tree(main_index.write_tree().unwrap())
            .unwrap();
        let main_parent = main_repo.head().unwrap().peel_to_commit().unwrap();
        main_repo
            .commit(
                Some("HEAD"),
                &sig,
                &sig,
                "main commit",
                &main_tree,
                &[&main_parent],
            )
            .unwrap();

        let result = state
            .promote_session("proj-a", &repo_root, "sess-1")
            .unwrap();
        assert!(!result.fast_forward);
        assert!(!result.up_to_date);
        assert!(result.merge_commit_sha.is_some());
        assert!(repo_root.join("from-session.txt").exists());
        assert!(repo_root.join("from-main.txt").exists());

        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[test]
    fn promote_session_aborts_cleanly_on_conflict() {
        let repo_root = init_test_repo();
        let state = GitEngineState::default();
        let wt_path = state
            .ensure_workbench_binding(
                "proj-a",
                &repo_root,
                "sess-1",
                &WorkbenchBinding::New {
                    branch: "conflicting".to_string(),
                },
            )
            .unwrap();

        // Session branch changes README.md.
        std::fs::write(wt_path.join("README.md"), "from session\n").unwrap();
        let wt_repo = Repository::open(&wt_path).unwrap();
        let mut wt_index = wt_repo.index().unwrap();
        wt_index.add_path(Path::new("README.md")).unwrap();
        wt_index.write().unwrap();
        let wt_tree = wt_repo.find_tree(wt_index.write_tree().unwrap()).unwrap();
        let sig = Signature::now("Test", "test@example.com").unwrap();
        let wt_parent = wt_repo.head().unwrap().peel_to_commit().unwrap();
        wt_repo
            .commit(
                Some("HEAD"),
                &sig,
                &sig,
                "session edit",
                &wt_tree,
                &[&wt_parent],
            )
            .unwrap();

        // Main workspace changes the very same file differently.
        std::fs::write(repo_root.join("README.md"), "from main\n").unwrap();
        let main_repo = Repository::open(&repo_root).unwrap();
        let mut main_index = main_repo.index().unwrap();
        main_index.add_path(Path::new("README.md")).unwrap();
        main_index.write().unwrap();
        let main_tree = main_repo
            .find_tree(main_index.write_tree().unwrap())
            .unwrap();
        let main_parent = main_repo.head().unwrap().peel_to_commit().unwrap();
        main_repo
            .commit(
                Some("HEAD"),
                &sig,
                &sig,
                "main edit",
                &main_tree,
                &[&main_parent],
            )
            .unwrap();

        let result = state.promote_session("proj-a", &repo_root, "sess-1");
        assert!(result.is_err());

        // Workspace must be left clean, back at its own HEAD content, not mid-conflict.
        let content = std::fs::read_to_string(repo_root.join("README.md")).unwrap();
        assert_eq!(content, "from main\n");
        // The workspace must be left clean relative to tracked content — no lingering merge
        // conflict markers or partial state. `.gitignore` shows up untracked because binding
        // the session's worktree wrote it out (same as ensure_worktree elsewhere) without
        // committing it, which is expected and unrelated to the aborted merge.
        let status = git_status_for(&repo_root).unwrap();
        assert!(status.iter().all(|entry| entry.path == ".gitignore"));

        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[test]
    fn promote_session_errors_for_main_binding_with_no_branch() {
        let repo_root = init_test_repo();
        let state = GitEngineState::default();
        state
            .ensure_workbench_binding("proj-a", &repo_root, "sess-1", &WorkbenchBinding::Main)
            .unwrap();

        let result = state.promote_session("proj-a", &repo_root, "sess-1");
        assert!(result.is_err());

        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[test]
    fn discard_workbench_binding_deletes_new_branch() {
        let repo_root = init_test_repo();
        let state = GitEngineState::default();
        let wt_path = state
            .ensure_workbench_binding(
                "proj-a",
                &repo_root,
                "sess-1",
                &WorkbenchBinding::New {
                    branch: "throwaway".to_string(),
                },
            )
            .unwrap();
        assert!(wt_path.exists());

        state
            .discard_workbench_binding("proj-a", &repo_root, "sess-1")
            .unwrap();

        assert!(!wt_path.exists());
        let repo = Repository::open(&repo_root).unwrap();
        assert!(repo
            .find_branch("throwaway", git2::BranchType::Local)
            .is_err());

        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[test]
    fn discard_workbench_binding_keeps_existing_branch() {
        let repo_root = init_test_repo();
        let repo = Repository::open(&repo_root).unwrap();
        let head_commit = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("keep-me", &head_commit, false).unwrap();
        let state = GitEngineState::default();
        let wt_path = state
            .ensure_workbench_binding(
                "proj-a",
                &repo_root,
                "sess-1",
                &WorkbenchBinding::Existing {
                    branch: "keep-me".to_string(),
                },
            )
            .unwrap();
        assert!(wt_path.exists());

        state
            .discard_workbench_binding("proj-a", &repo_root, "sess-1")
            .unwrap();

        assert!(!wt_path.exists());
        let repo = Repository::open(&repo_root).unwrap();
        assert!(repo.find_branch("keep-me", git2::BranchType::Local).is_ok());

        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[test]
    fn discard_workbench_binding_is_noop_for_main_and_unknown_session() {
        let repo_root = init_test_repo();
        let state = GitEngineState::default();
        state
            .ensure_workbench_binding("proj-a", &repo_root, "sess-1", &WorkbenchBinding::Main)
            .unwrap();

        assert!(state
            .discard_workbench_binding("proj-a", &repo_root, "sess-1")
            .is_ok());
        assert!(state
            .discard_workbench_binding("proj-a", &repo_root, "ghost-session")
            .is_ok());

        let _ = std::fs::remove_dir_all(&repo_root);
    }

    // --- Orchestration: staging branch + task worktrees ---

    fn commit_file(repo_path: &Path, name: &str, contents: &str, message: &str) {
        let repo = Repository::open(repo_path).unwrap();
        std::fs::write(repo_path.join(name), contents).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new(name)).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = Signature::now("Test", "test@example.com").unwrap();
        let parent = repo.head().unwrap().peel_to_commit().unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &[&parent])
            .unwrap();
    }

    #[test]
    fn reset_staging_creates_branch_at_current_head() {
        let repo_root = init_test_repo();
        let state = GitEngineState::default();

        state.reset_staging("proj-a", &repo_root).unwrap();

        let repo = Repository::open(&repo_root).unwrap();
        let staging = repo
            .find_branch(STAGING_BRANCH, git2::BranchType::Local)
            .unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(staging.get().peel_to_commit().unwrap().id(), head.id());

        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[test]
    fn create_task_worktree_branches_off_staging_tip() {
        let repo_root = init_test_repo();
        let state = GitEngineState::default();
        state.reset_staging("proj-a", &repo_root).unwrap();

        let wt_path = state
            .create_task_worktree("proj-a", &repo_root, "task-1")
            .unwrap();

        assert!(wt_path.exists());
        let repo = Repository::open(&repo_root).unwrap();
        let task_branch = repo
            .find_branch("task/task-1", git2::BranchType::Local)
            .unwrap();
        let staging = repo
            .find_branch(STAGING_BRANCH, git2::BranchType::Local)
            .unwrap();
        assert_eq!(
            task_branch.get().peel_to_commit().unwrap().id(),
            staging.get().peel_to_commit().unwrap().id()
        );
        assert_eq!(state.task_worktree_path("proj-a", "task-1"), Some(wt_path));

        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[test]
    fn create_task_worktree_recreates_fresh_on_retry() {
        let repo_root = init_test_repo();
        let state = GitEngineState::default();
        state.reset_staging("proj-a", &repo_root).unwrap();

        let first = state
            .create_task_worktree("proj-a", &repo_root, "task-1")
            .unwrap();
        std::fs::write(first.join("scratch.txt"), "attempt one\n").unwrap();

        // A second call (as happens on a bounce retry) must wipe the previous attempt's edits.
        let second = state
            .create_task_worktree("proj-a", &repo_root, "task-1")
            .unwrap();

        assert_eq!(first, second);
        assert!(!second.join("scratch.txt").exists());

        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[test]
    fn merge_task_into_staging_fast_forwards() {
        let repo_root = init_test_repo();
        let state = GitEngineState::default();
        state.reset_staging("proj-a", &repo_root).unwrap();
        let wt_path = state
            .create_task_worktree("proj-a", &repo_root, "task-1")
            .unwrap();
        commit_file(&wt_path, "from-task.txt", "hello\n", "task edit");

        state
            .merge_task_into_staging("proj-a", &repo_root, "task-1")
            .unwrap();

        let repo = Repository::open(&repo_root).unwrap();
        let staging = repo
            .find_branch(STAGING_BRANCH, git2::BranchType::Local)
            .unwrap();
        let task = repo
            .find_branch("task/task-1", git2::BranchType::Local)
            .unwrap();
        assert_eq!(
            staging.get().peel_to_commit().unwrap().id(),
            task.get().peel_to_commit().unwrap().id()
        );
        // The main workspace itself must be untouched by a staging-only merge.
        assert!(!repo_root.join("from-task.txt").exists());

        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[test]
    fn merge_task_into_staging_creates_merge_commit_for_two_disjoint_tasks() {
        let repo_root = init_test_repo();
        let state = GitEngineState::default();
        state.reset_staging("proj-a", &repo_root).unwrap();

        let wt_a = state
            .create_task_worktree("proj-a", &repo_root, "task-a")
            .unwrap();
        let wt_b = state
            .create_task_worktree("proj-a", &repo_root, "task-b")
            .unwrap();
        commit_file(&wt_a, "a.txt", "a\n", "task a edit");
        commit_file(&wt_b, "b.txt", "b\n", "task b edit");

        state
            .merge_task_into_staging("proj-a", &repo_root, "task-a")
            .unwrap();
        state
            .merge_task_into_staging("proj-a", &repo_root, "task-b")
            .unwrap();

        let staging_path = state
            .refresh_staging_worktree("proj-a", &repo_root)
            .unwrap();
        assert!(staging_path.join("a.txt").exists());
        assert!(staging_path.join("b.txt").exists());

        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[test]
    fn merge_task_into_staging_reports_conflict_without_mutating_staging() {
        let repo_root = init_test_repo();
        let state = GitEngineState::default();
        state.reset_staging("proj-a", &repo_root).unwrap();

        // Both tasks fork from the same original staging tip before either merges, and both
        // edit the same file — a real race a scope-overlap check would normally prevent, but
        // exercised directly here to prove the merge itself detects and cleanly rejects it.
        let wt_a = state
            .create_task_worktree("proj-a", &repo_root, "task-a")
            .unwrap();
        let wt_b = state
            .create_task_worktree("proj-a", &repo_root, "task-b")
            .unwrap();
        commit_file(&wt_a, "README.md", "from task a\n", "task a edits README");
        commit_file(&wt_b, "README.md", "from task b\n", "task b edits README");

        state
            .merge_task_into_staging("proj-a", &repo_root, "task-a")
            .unwrap();
        let staging_after_a = {
            let repo = Repository::open(&repo_root).unwrap();
            let oid = repo
                .find_branch(STAGING_BRANCH, git2::BranchType::Local)
                .unwrap()
                .get()
                .peel_to_commit()
                .unwrap()
                .id();
            oid
        };

        let result = state.merge_task_into_staging("proj-a", &repo_root, "task-b");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("README.md"));

        // central/staging must be exactly where it was before the failed merge attempt.
        let repo = Repository::open(&repo_root).unwrap();
        let staging_now = repo
            .find_branch(STAGING_BRANCH, git2::BranchType::Local)
            .unwrap()
            .get()
            .peel_to_commit()
            .unwrap()
            .id();
        assert_eq!(staging_now, staging_after_a);

        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[test]
    fn promote_staging_to_main_fast_forwards_main_workspace() {
        let repo_root = init_test_repo();
        let state = GitEngineState::default();
        state.reset_staging("proj-a", &repo_root).unwrap();
        let wt_path = state
            .create_task_worktree("proj-a", &repo_root, "task-1")
            .unwrap();
        commit_file(&wt_path, "from-task.txt", "hello\n", "task edit");
        state
            .merge_task_into_staging("proj-a", &repo_root, "task-1")
            .unwrap();

        let result = state.promote_staging_to_main("proj-a", &repo_root).unwrap();

        assert!(result.fast_forward);
        assert!(repo_root.join("from-task.txt").exists());

        let _ = std::fs::remove_dir_all(&repo_root);
    }

    #[test]
    fn reset_staging_sweeps_previous_runs_task_branches() {
        let repo_root = init_test_repo();
        let state = GitEngineState::default();
        state.reset_staging("proj-a", &repo_root).unwrap();
        state
            .create_task_worktree("proj-a", &repo_root, "task-1")
            .unwrap();

        state.reset_staging("proj-a", &repo_root).unwrap();

        let repo = Repository::open(&repo_root).unwrap();
        assert!(repo
            .find_branch("task/task-1", git2::BranchType::Local)
            .is_err());
        assert_eq!(state.task_worktree_path("proj-a", "task-1"), None);

        let _ = std::fs::remove_dir_all(&repo_root);
    }
}
