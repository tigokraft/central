use std::collections::HashMap;

use super::task::{OrchestratorTask, TaskState};

/// Pure scheduling core: given the full task list, every task's current state, and the run's
/// max-parallel setting, returns the ids of tasks that may start *right now*. No AppHandle, no
/// git, no process spawning — the dispatcher (run.rs) is the only caller, and it re-derives this
/// on every tick against whatever states it's tracking. Kept pure and free-standing so dependency
/// ordering, scope-overlap exclusion, and the max-parallel cap can each be exercised directly.
///
/// A task is runnable when:
/// - it is `Pending` (not already running/merged/done/failed — `Bounced` is never observed here
///   since the dispatcher flips a bounced task back to `Pending` before the next tick),
/// - every task it `dependsOn` is `Done`,
/// - its `fileScopes` don't overlap (glob/prefix match) any task currently `Running` or
///   `Merging`, or any other task claimed earlier in this same pass, and
/// - there's still parallel capacity left (`max_parallel` minus tasks already `Running`).
///
/// Tasks are considered in list order, so earlier tasks in the input get first claim on
/// contested scopes/capacity within a single call — callers that care about fairness should
/// rotate the input order themselves.
pub fn runnable_tasks(
    tasks: &[OrchestratorTask],
    states: &HashMap<String, TaskState>,
    max_parallel: usize,
) -> Vec<String> {
    let state_of = |id: &str| states.get(id).copied().unwrap_or(TaskState::Pending);

    let running_count = tasks
        .iter()
        .filter(|t| state_of(&t.id) == TaskState::Running)
        .count();
    if max_parallel == 0 || running_count >= max_parallel {
        return Vec::new();
    }
    let mut capacity = max_parallel - running_count;

    // Scopes already "claimed" by in-flight work: tasks actively running or mid-merge, plus
    // (as the loop below proceeds) every task this same call decides to start.
    let mut claimed_scopes: Vec<&[String]> = tasks
        .iter()
        .filter(|t| matches!(state_of(&t.id), TaskState::Running | TaskState::Merging))
        .map(|t| t.file_scopes.as_slice())
        .collect();

    let mut result = Vec::new();
    for task in tasks {
        if capacity == 0 {
            break;
        }
        if state_of(&task.id) != TaskState::Pending {
            continue;
        }
        let deps_satisfied = task
            .depends_on
            .iter()
            .all(|dep| state_of(dep) == TaskState::Done);
        if !deps_satisfied {
            continue;
        }
        if claimed_scopes
            .iter()
            .any(|scopes| scopes_overlap(scopes, &task.file_scopes))
        {
            continue;
        }

        claimed_scopes.push(task.file_scopes.as_slice());
        result.push(task.id.clone());
        capacity -= 1;
    }

    result
}

/// True if any path in `a` overlaps (exact match, or a directory-boundary prefix of) any path in
/// `b`. An empty scope list is treated as "touches anything" — a task the Decomposer didn't
/// bother to scope conservatively excludes everything else rather than risk a real collision.
pub fn scopes_overlap(a: &[String], b: &[String]) -> bool {
    if a.is_empty() || b.is_empty() {
        return true;
    }
    a.iter().any(|pa| b.iter().any(|pb| paths_overlap(pa, pb)))
}

fn normalize_scope(raw: &str) -> String {
    let trimmed = raw.trim().trim_start_matches("./");
    // Strip a trailing glob (`/**`, `/*`, or a bare `*`) down to the directory it scopes —
    // scope entries are matched as directory-boundary prefixes regardless of whether the
    // Decomposer wrote an explicit glob or just a plain directory/file path.
    let without_glob = trimmed
        .strip_suffix("/**")
        .or_else(|| trimmed.strip_suffix("/*"))
        .unwrap_or(trimmed)
        .trim_end_matches('*');
    without_glob.trim_end_matches('/').to_string()
}

fn paths_overlap(raw_a: &str, raw_b: &str) -> bool {
    let a = normalize_scope(raw_a);
    let b = normalize_scope(raw_b);
    // A scope that normalizes to empty (e.g. "*" or "**" alone) means "everything."
    if a.is_empty() || b.is_empty() {
        return true;
    }
    a == b || b.starts_with(&format!("{a}/")) || a.starts_with(&format!("{b}/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(id: &str, scopes: &[&str], deps: &[&str]) -> OrchestratorTask {
        OrchestratorTask {
            id: id.to_string(),
            title: id.to_string(),
            prompt: format!("do {id}"),
            file_scopes: scopes.iter().map(|s| s.to_string()).collect(),
            depends_on: deps.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn schedules_all_independent_disjoint_tasks_up_to_capacity() {
        let tasks = vec![
            task("a", &["src/a.rs"], &[]),
            task("b", &["src/b.rs"], &[]),
            task("c", &["src/c.rs"], &[]),
        ];
        let states = HashMap::new();

        let runnable = runnable_tasks(&tasks, &states, 10);

        assert_eq!(runnable, vec!["a", "b", "c"]);
    }

    #[test]
    fn respects_max_parallel_cap() {
        let tasks = vec![
            task("a", &["src/a.rs"], &[]),
            task("b", &["src/b.rs"], &[]),
            task("c", &["src/c.rs"], &[]),
        ];
        let states = HashMap::new();

        let runnable = runnable_tasks(&tasks, &states, 2);

        assert_eq!(runnable, vec!["a", "b"]);
    }

    #[test]
    fn max_parallel_cap_accounts_for_already_running_tasks() {
        let tasks = vec![
            task("a", &["src/a.rs"], &[]),
            task("b", &["src/b.rs"], &[]),
            task("c", &["src/c.rs"], &[]),
        ];
        let mut states = HashMap::new();
        states.insert("a".to_string(), TaskState::Running);

        let runnable = runnable_tasks(&tasks, &states, 2);

        assert_eq!(runnable, vec!["b"]);
    }

    #[test]
    fn zero_max_parallel_schedules_nothing() {
        let tasks = vec![task("a", &["src/a.rs"], &[])];
        let states = HashMap::new();

        assert!(runnable_tasks(&tasks, &states, 0).is_empty());
    }

    #[test]
    fn blocks_task_until_its_dependency_is_done() {
        let tasks = vec![
            task("a", &["src/a.rs"], &[]),
            task("b", &["src/b.rs"], &["a"]),
        ];
        let states = HashMap::new();

        assert_eq!(runnable_tasks(&tasks, &states, 10), vec!["a"]);

        let mut states = HashMap::new();
        states.insert("a".to_string(), TaskState::Running);
        assert!(runnable_tasks(&tasks, &states, 10).is_empty());

        let mut states = HashMap::new();
        states.insert("a".to_string(), TaskState::Done);
        assert_eq!(runnable_tasks(&tasks, &states, 10), vec!["b"]);
    }

    #[test]
    fn a_task_still_merging_blocks_dependents_from_starting() {
        // "Done" only happens once the integrator has actually merged the branch — a
        // dependent must not start against a base that doesn't include it yet.
        let tasks = vec![
            task("a", &["src/a.rs"], &[]),
            task("b", &["src/b.rs"], &["a"]),
        ];
        let mut states = HashMap::new();
        states.insert("a".to_string(), TaskState::Merging);

        assert!(runnable_tasks(&tasks, &states, 10).is_empty());
    }

    #[test]
    fn excludes_tasks_with_overlapping_scopes() {
        let tasks = vec![
            task("a", &["src/auth"], &[]),
            task("b", &["src/auth/handler.rs"], &[]),
            task("c", &["src/unrelated.rs"], &[]),
        ];
        let states = HashMap::new();

        let runnable = runnable_tasks(&tasks, &states, 10);

        // "a" claims src/auth first; "b" is a sub-path of that and is excluded this round.
        assert_eq!(runnable, vec!["a", "c"]);
    }

    #[test]
    fn excludes_task_whose_scope_overlaps_an_already_running_task() {
        let tasks = vec![
            task("a", &["src/auth/handler.rs"], &[]),
            task("b", &["src/auth"], &[]),
        ];
        let mut states = HashMap::new();
        states.insert("a".to_string(), TaskState::Running);

        assert!(runnable_tasks(&tasks, &states, 10).is_empty());
    }

    #[test]
    fn does_not_treat_sibling_directories_as_overlapping() {
        let tasks = vec![
            task("a", &["src/authentication"], &[]),
            task("b", &["src/auth"], &[]),
        ];
        let states = HashMap::new();

        // "src/authentication" is NOT a sub-path of "src/auth" at a directory boundary, so
        // both are free to run together.
        assert_eq!(runnable_tasks(&tasks, &states, 10), vec!["a", "b"]);
    }

    #[test]
    fn unscoped_task_conservatively_excludes_everything_else() {
        let tasks = vec![task("a", &[], &[]), task("b", &["src/b.rs"], &[])];
        let states = HashMap::new();

        assert_eq!(runnable_tasks(&tasks, &states, 10), vec!["a"]);
    }

    #[test]
    fn done_and_failed_tasks_are_never_rescheduled() {
        let tasks = vec![task("a", &["src/a.rs"], &[]), task("b", &["src/b.rs"], &[])];
        let mut states = HashMap::new();
        states.insert("a".to_string(), TaskState::Done);
        states.insert("b".to_string(), TaskState::Failed);

        assert!(runnable_tasks(&tasks, &states, 10).is_empty());
    }

    #[test]
    fn a_dependent_of_a_failed_task_never_becomes_runnable() {
        let tasks = vec![
            task("a", &["src/a.rs"], &[]),
            task("b", &["src/b.rs"], &["a"]),
        ];
        let mut states = HashMap::new();
        states.insert("a".to_string(), TaskState::Failed);

        assert!(runnable_tasks(&tasks, &states, 10).is_empty());
    }

    #[test]
    fn scopes_overlap_matches_exact_and_prefix_but_not_siblings() {
        assert!(scopes_overlap(&["src/a.rs".into()], &["src/a.rs".into()]));
        assert!(scopes_overlap(
            &["src/auth".into()],
            &["src/auth/handler.rs".into()]
        ));
        assert!(scopes_overlap(
            &["src/auth/**".into()],
            &["src/auth/handler.rs".into()]
        ));
        assert!(!scopes_overlap(
            &["src/auth".into()],
            &["src/authorization.rs".into()]
        ));
        assert!(!scopes_overlap(&["src/a.rs".into()], &["src/b.rs".into()]));
    }

    #[test]
    fn empty_scope_lists_overlap_with_anything() {
        assert!(scopes_overlap(&[], &["src/a.rs".into()]));
        assert!(scopes_overlap(&["src/a.rs".into()], &[]));
        assert!(scopes_overlap(&[], &[]));
    }
}
