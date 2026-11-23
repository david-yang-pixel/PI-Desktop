//! Cloning a repository's main checkout. A clone is written to a sibling
//! temporary directory and renamed into place only on success, so an
//! interrupted clone never leaves a half-written directory where the main
//! checkout belongs.
//!
//! A clone that failed or was cut short (a timeout, a stalled transfer, a
//! host-core restart) is kept, and the next attempt completes it with a
//! fetch and a checkout instead of starting over; whatever objects and refs
//! it already has are not transferred again. A cancelled clone is removed:
//! the caller asked for it to stop. This stays a full clone: a partial clone
//! would make later offline git commands need the proxy and the credential.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use super::layout::validate_branch;
use super::repository::{run, NetworkContext, CLONE_TIMEOUT};
use super::WorkspaceGitError;

/// How deep the stale-lock sweep of a kept clone's git directory goes.
const LOCK_SWEEP_DEPTH: usize = 8;

pub(super) async fn clone(
    ctx: &NetworkContext<'_>,
    remote_url: &str,
    parent: &Path,
    name: &str,
    main_path: &Path,
) -> Result<(), WorkspaceGitError> {
    let mut temporary = TemporaryClone::new(parent, name);
    let Some(target) = temporary.path.to_str().map(str::to_string) else {
        return Err(WorkspaceGitError::invalid("invalid main checkout path"));
    };
    let result = if resumable(ctx, &temporary.path, remote_url).await {
        resume(ctx, &temporary.path).await
    } else {
        remove_path(&temporary.path)?;
        let args = [
            "clone",
            "--progress",
            "--origin",
            "origin",
            "--",
            remote_url,
            &target,
        ];
        run(ctx, parent, "clone", &args, CLONE_TIMEOUT).await
    };
    if let Err(error) = result {
        // Not cancelled (that drops this future): keep what was transferred
        // for the next attempt, unless a retry cannot get further anyway.
        temporary.keep = !matches!(
            error.code,
            "WORKSPACE_GIT_AUTH_REQUIRED"
                | "WORKSPACE_GIT_REPOSITORY_NOT_FOUND"
                | "WORKSPACE_GIT_UNAVAILABLE"
        );
        return Err(error);
    }
    fs::rename(&temporary.path, main_path)?;
    temporary.keep = true;
    Ok(())
}

/// Whether `path` is a kept clone of `remote_url`: a real directory with a
/// real git directory whose `origin` is that URL. Anything else is removed.
async fn resumable(ctx: &NetworkContext<'_>, path: &Path, remote_url: &str) -> bool {
    let git_dir = path.join(".git");
    let real_dir = |path: &Path| fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir());
    if !real_dir(path) || !real_dir(&git_dir) {
        return false;
    }
    ctx.git
        .run_git_dir(&git_dir, &["config", "--get", "remote.origin.url"])
        .await
        .is_ok_and(|url| url.trim() == remote_url)
}

/// Finish a kept clone: fetch what is missing, then check out the remote's
/// default branch the way `git clone` does.
async fn resume(ctx: &NetworkContext<'_>, path: &Path) -> Result<(), WorkspaceGitError> {
    // Only this clone's own git processes ever wrote here, and the transfer
    // lock keeps any other away: a lock left behind is from a killed one.
    remove_stale_locks(&path.join(".git"), LOCK_SWEEP_DEPTH)?;
    let fetch = ["fetch", "--progress", "--prune", "--", "origin"];
    run(ctx, path, "fetch", &fetch, CLONE_TIMEOUT).await?;
    let branch = match default_branch(ctx, path).await? {
        Some(branch) => branch,
        None => {
            // `git clone` records the remote's HEAD after its transfer; a
            // clone cut short earlier asks the remote now.
            let set_head = ["remote", "set-head", "origin", "--auto"];
            run(ctx, path, "remote set-head", &set_head, CLONE_TIMEOUT).await?;
            default_branch(ctx, path).await?.ok_or_else(|| {
                WorkspaceGitError::failed("the remote does not name a default branch")
            })?
        }
    };
    let start = format!("refs/remotes/origin/{branch}");
    // `-f`: a checkout cut short leaves files git did not finish writing.
    let checkout = ["checkout", "-q", "-f", "-B", &branch, "--track", &start];
    run(ctx, path, "checkout", &checkout, CLONE_TIMEOUT).await
}

/// The branch `refs/remotes/origin/HEAD` names, if it is set.
async fn default_branch(
    ctx: &NetworkContext<'_>,
    path: &Path,
) -> Result<Option<String>, WorkspaceGitError> {
    let output = ctx
        .git
        .output(path, &["symbolic-ref", "-q", "refs/remotes/origin/HEAD"])
        .await
        .map_err(|error| super::repository::from_git_error("symbolic-ref", error))?;
    if !output.success() {
        return Ok(None);
    }
    let Some(branch) = output.stdout.trim().strip_prefix("refs/remotes/origin/") else {
        return Ok(None);
    };
    validate_branch(branch)?;
    Ok(Some(branch.to_string()))
}

/// Remove `*.lock` files under `dir`, never following a link.
fn remove_stale_locks(dir: &Path, depth: usize) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_dir() && depth > 0 {
            remove_stale_locks(&entry.path(), depth - 1)?;
        } else if kind.is_file() && entry.file_name().to_string_lossy().ends_with(".lock") {
            fs::remove_file(entry.path())?;
        }
    }
    Ok(())
}

/// Temporary clones are named `<repo>.cloning-<suffix>.git`. No repository
/// name may end in `.git`, so the name can never be another repository's main
/// checkout in the same owner directory.
const TEMPORARY_SUFFIX: &str = ".git";
/// The one temporary clone that is kept for the next attempt. Every other
/// name (random names older builds used) is a leftover.
const PARTIAL: &str = "partial";

fn temporary_prefix(name: &str) -> String {
    format!("{name}.cloning-")
}

fn partial_name(name: &str) -> String {
    format!("{}{PARTIAL}{TEMPORARY_SUFFIX}", temporary_prefix(name))
}

/// Remove what an interrupted clone of this repository left behind, except
/// the kept partial clone, which `clone` resumes or replaces.
pub(super) fn remove_leftover_clones(parent: &Path, name: &str) -> Result<(), WorkspaceGitError> {
    let prefix = temporary_prefix(name);
    let partial = partial_name(name);
    for entry in fs::read_dir(parent)? {
        let entry = entry?;
        let file_name = entry.file_name();
        let Some(file_name) = file_name.to_str() else {
            continue;
        };
        if file_name.starts_with(&prefix)
            && file_name.ends_with(TEMPORARY_SUFFIX)
            && file_name != partial
        {
            remove_path(&entry.path())?;
        }
    }
    Ok(())
}

/// Remove a directory tree, or a link or file as itself (never its target).
fn remove_path(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

/// The directory a clone is written to until it succeeds. Dropping it
/// without `keep` (a cancelled job whose future is dropped, or a failure no
/// retry gets past) removes it.
struct TemporaryClone {
    path: PathBuf,
    keep: bool,
}

impl TemporaryClone {
    fn new(parent: &Path, name: &str) -> Self {
        Self {
            path: parent.join(partial_name(name)),
            keep: false,
        }
    }
}

impl Drop for TemporaryClone {
    fn drop(&mut self) {
        if self.keep {
            return;
        }
        // Best effort: a git child that outlives its killed parent may still
        // be writing; whatever remains is replaced by the next `ensure`.
        if let Err(error) = remove_path(&self.path) {
            tracing::warn!(%error, "could not remove an interrupted clone directory");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_worktrees::git::GitRunner;
    use crate::session_worktrees::test_support::git_cmd;
    use crate::workspace_git::repository::{ensure, Phase};
    use crate::workspace_git::test_support::{rev_parse, Remote};

    fn context(git: &GitRunner) -> NetworkContext<'_> {
        NetworkContext {
            git,
            config: &[],
            on_progress: None,
        }
    }

    /// A clone cut short after it wrote its configuration: what a host-core
    /// restart, or a timeout that killed git, leaves behind.
    fn cut_short(partial: &Path, url: &str) {
        fs::create_dir_all(partial).unwrap();
        git_cmd(partial, &["init", "-q"]);
        git_cmd(partial, &["remote", "add", "origin", url]);
        // Marks the directory as the one that was resumed, not recloned.
        fs::write(partial.join(".git/pi-resumed"), "").unwrap();
        // A lock a killed git process never released.
        fs::write(partial.join(".git/index.lock"), "").unwrap();
    }

    #[tokio::test]
    async fn a_clone_cut_short_is_completed_on_the_next_attempt() {
        let dir = tempfile::tempdir().unwrap();
        let remote = Remote::new(dir.path());
        let parent = dir.path().join("root/repos/github.com/octo");
        let main_path = parent.join("repo");
        cut_short(&parent.join("repo.cloning-partial.git"), &remote.url());
        let git = GitRunner::default();
        let phases = std::sync::Mutex::new(Vec::new());
        ensure(&context(&git), &remote.url(), &main_path, &|phase| {
            phases.lock().unwrap().push(phase)
        })
        .await
        .unwrap();
        assert_eq!(*phases.lock().unwrap(), [Phase::Cloning]);
        assert!(main_path.join(".git/pi-resumed").is_file(), "recloned");
        assert!(main_path.join("README.md").is_file());
        assert_eq!(
            git_cmd(&main_path, &["symbolic-ref", "--short", "HEAD"]).trim(),
            "main"
        );
        assert_eq!(rev_parse(&main_path, "HEAD"), remote.head("main"));
        assert_eq!(
            rev_parse(&main_path, "refs/remotes/origin/develop"),
            remote.head("develop")
        );
        assert_eq!(
            git_cmd(&main_path, &["config", "--get", "branch.main.remote"]).trim(),
            "origin"
        );
        assert!(git_cmd(&main_path, &["status", "--porcelain"]).is_empty());
        let leftovers: Vec<_> = fs::read_dir(&parent)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .filter(|name| name != "repo")
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    #[tokio::test]
    async fn a_partial_clone_of_another_url_is_discarded() {
        let dir = tempfile::tempdir().unwrap();
        let remote = Remote::new(dir.path());
        let parent = dir.path().join("root/repos/github.com/octo");
        let main_path = parent.join("repo");
        cut_short(
            &parent.join("repo.cloning-partial.git"),
            "https://github.com/someone/else.git",
        );
        let git = GitRunner::default();
        ensure(&context(&git), &remote.url(), &main_path, &|_| {})
            .await
            .unwrap();
        assert!(!main_path.join(".git/pi-resumed").exists());
        assert_eq!(rev_parse(&main_path, "HEAD"), remote.head("main"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_failed_clone_is_kept_for_the_next_attempt_to_finish() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let remote = Remote::new(dir.path());
        let parent = dir.path().join("root/repos/github.com/octo");
        let main_path = parent.join("repo");
        // The transfer completes, then git is cut off (as a timeout would).
        let script = dir.path().join("cut-git");
        fs::write(
            &script,
            "#!/bin/sh\ncase \" $* \" in *' clone '*) git \"$@\"; exit 1;; esac\nexec git \"$@\"\n",
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        let cut = GitRunner::with_program(script);
        let error = ensure(&context(&cut), &remote.url(), &main_path, &|_| {})
            .await
            .unwrap_err();
        assert_eq!(error.code, "WORKSPACE_GIT_FAILED", "{error}");
        assert!(!main_path.exists());
        let partial = parent.join("repo.cloning-partial.git");
        assert!(
            partial.join(".git").is_dir(),
            "the partial clone was thrown away"
        );
        fs::write(partial.join(".git/pi-resumed"), "").unwrap();
        let git = GitRunner::default();
        ensure(&context(&git), &remote.url(), &main_path, &|_| {})
            .await
            .unwrap();
        assert!(main_path.join(".git/pi-resumed").is_file());
        assert_eq!(rev_parse(&main_path, "HEAD"), remote.head("main"));
        assert!(!partial.exists());
    }
}
