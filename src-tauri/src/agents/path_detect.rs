use std::path::Path;

// Pure (takes PATH as a string rather than reading the environment itself) so adapter
// detection can be unit tested against a fake PATH without touching real process state.
pub fn is_executable_on_path(bin_name: &str, path_env: &str) -> bool {
    std::env::split_paths(path_env).any(|dir| binary_exists_in_dir(&dir, bin_name))
}

#[cfg(unix)]
fn binary_exists_in_dir(dir: &Path, bin_name: &str) -> bool {
    use std::os::unix::fs::PermissionsExt;
    let candidate = dir.join(bin_name);
    candidate
        .metadata()
        .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(windows)]
fn binary_exists_in_dir(dir: &Path, bin_name: &str) -> bool {
    ["", ".exe", ".cmd", ".bat"]
        .iter()
        .any(|ext| dir.join(format!("{bin_name}{ext}")).is_file())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    fn unique_temp_dir(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "central-agents-test-{label}-{:?}",
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[cfg(unix)]
    fn write_executable(dir: &Path, name: &str) {
        let path = dir.join(name);
        fs::write(&path, b"#!/bin/sh\necho hi\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn finds_executable_present_on_a_fake_path() {
        let dir = unique_temp_dir("found");
        write_executable(&dir, "claude");
        let fake_path = dir.display().to_string();
        assert!(is_executable_on_path("claude", &fake_path));
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn does_not_find_a_binary_missing_from_the_fake_path() {
        let dir = unique_temp_dir("missing");
        write_executable(&dir, "claude");
        let fake_path = dir.display().to_string();
        assert!(!is_executable_on_path("gemini", &fake_path));
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn ignores_a_non_executable_file_with_a_matching_name() {
        let dir = unique_temp_dir("non-exec");
        let path = dir.join("claude");
        fs::write(&path, b"not a real binary").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        let fake_path = dir.display().to_string();
        assert!(!is_executable_on_path("claude", &fake_path));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_path_never_matches() {
        assert!(!is_executable_on_path("claude", ""));
    }
}
