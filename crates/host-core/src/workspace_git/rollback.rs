//! Undo a checkout creation that never completed.
//!
//! A prepare writes its registration with `checkout_creation_pending` before
//! `git worktree add` runs, and clears it once the checkout is complete. A
//! new session's registration also carries `branch_creation_pending`, because
//! the same step creates its work branch. Until the flags clear, tools refuse
//! the registration, so the checkout holds only what git wrote. When the
//! prepare is cancelled, fails, or is cut short by a restart, this removes:
//!
//! - the checkout, when it is empty or is the linked worktree git created
//!   for the registered path in this repository. Anything else there was not
//!   made by that step and is never removed;
//! - git's worktree entry for the registered path;
//! - a work branch the step created, and only while it still points at the
//!   commit it started at, so a commit made on it is never lost.

use std::path::Path;
use std::{fs, io};

use super::layout::{short_id, validate_branch, work_branch};
use super::registry::WorktreeRecord;
use super::{reclaim, repository, WorkspaceGitError};
use crate::session_worktrees::git::GitRunner;
use crate::session_worktrees::remove::{clear_contents, drop_admin_entry};
use crate::session_worktrees::repo_lock;
use crate::workspace::simple_canonicalize;

/// What `.git` and git's `gitdir` back-link can be: a line holding a path.
const MAX_LINK_BYTES: u64 = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Checkout {
    Absent,
    /// An empty directory, or the linked worktree of this repository at the
    /// registered path.
    Created,
    /// Something git did not create for this registration.
    Foreign,
}

fn moved() -> WorkspaceGitError {
    WorkspaceGitError::failed(
        "the work branch of an unfinished workspace has new commits; remove it with force to discard it",
    )
}

/// Undo what an unfinished creation made for `record`. The caller holds the
/// session's exclusive access and updates the registration afterwards.
///
/// For a new session (`branch_creation_pending`) a foreign entry at the path
/// is left in place: the registration is dropped and no longer claims it.
/// For a checkout restored on a retained branch, it stops the rollback,
/// because clearing the flag would make that entry the session's checkout.
pub async fn roll_back(git: &GitRunner, record: &WorktreeRecord) -> Result<(), WorkspaceGitError> {
    validate_branch(&record.work_branch)?;
    let path = Path::new(&record.path);
    if record.work_branch != work_branch(&record.installation_id, &record.session_id)
        || path.file_name().and_then(|name| name.to_str())
            != Some(short_id(&record.installation_id, &record.session_id).as_str())
    {
        return Err(reclaim::interrupted());
    }
    let main = Path::new(&record.main_path);
    let common = repository::common_dir(main);
    let _lock = repo_lock::lock(&common).await;

    let created_branch = if record.recovery.branch_creation_pending {
        let head = local_branch(git, main, &record.work_branch).await?;
        if head
            .as_ref()
            .is_some_and(|head| *head != record.base_commit)
        {
            return Err(moved());
        }
        head
    } else {
        None
    };
    match classify(path, &common)? {
        Checkout::Absent => {}
        Checkout::Created => {
            // Links are removed as links (ADR 0329), never followed.
            clear_contents(path)?;
            fs::remove_dir_all(path)?;
        }
        Checkout::Foreign if record.recovery.branch_creation_pending => {}
        Checkout::Foreign => return Err(reclaim::interrupted()),
    }
    if common.is_dir() {
        drop_admin_entry(&common, path)?;
    }
    if let Some(head) = created_branch {
        let reference = format!("refs/heads/{}", record.work_branch);
        // Deletes only if the branch still points where it started.
        git.run(main, &["update-ref", "-d", &reference, &head])
            .await
            .map_err(|error| repository::from_git_error("update-ref", error))?;
        let section = format!("branch.{}", record.work_branch);
        let _ = git
            .output(
                main,
                &["config", "--local", "--remove-section", "--", &section],
            )
            .await;
    }
    Ok(())
}

/// The commit `refs/heads/<branch>` points at, or `None` when it is absent
/// (or the main checkout is gone with it).
async fn local_branch(
    git: &GitRunner,
    main: &Path,
    branch: &str,
) -> Result<Option<String>, WorkspaceGitError> {
    if !main.join(".git").is_dir() {
        return Ok(None);
    }
    let reference = format!("refs/heads/{branch}");
    let output = git
        .output(main, &["show-ref", "--verify", "--hash", "--", &reference])
        .await
        .map_err(|error| repository::from_git_error("show-ref", error))?;
    match output.status {
        0 => Ok(Some(output.stdout.trim().to_string())),
        1 => Ok(None),
        _ => Err(WorkspaceGitError::failed(
            "could not inspect the local work branch",
        )),
    }
}

fn classify(path: &Path, common: &Path) -> Result<Checkout, WorkspaceGitError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Checkout::Absent),
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_dir() {
        return Ok(Checkout::Foreign);
    }
    if fs::read_dir(path)?.next().is_none() || linked(path, common) {
        Ok(Checkout::Created)
    } else {
        Ok(Checkout::Foreign)
    }
}

/// Whether `path/.git` names an entry under `common/worktrees` whose `gitdir`
/// names `path/.git` back: both halves of the link `git worktree add` writes
/// before it checks out any file.
fn linked(path: &Path, common: &Path) -> bool {
    let link = path.join(".git");
    let Some(target) = read_link_line(&link) else {
        return false;
    };
    let Some(target) = target.strip_prefix("gitdir: ") else {
        return false;
    };
    let (Ok(admin), Ok(admin_root), Ok(link)) = (
        simple_canonicalize(&path.join(target)),
        simple_canonicalize(&common.join("worktrees")),
        simple_canonicalize(&link),
    ) else {
        return false;
    };
    if admin.parent() != Some(admin_root.as_path()) {
        return false;
    }
    read_link_line(&admin.join("gitdir"))
        .and_then(|back| simple_canonicalize(Path::new(&back)).ok())
        .is_some_and(|back| back == link)
}

/// The single line of a small regular file, never following a link.
fn read_link_line(file: &Path) -> Option<String> {
    let metadata = fs::symlink_metadata(file).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_LINK_BYTES {
        return None;
    }
    let text = fs::read_to_string(file).ok()?;
    let line = text.strip_suffix('\n').unwrap_or(&text);
    (!line.is_empty() && !line.contains(['\n', '\0'])).then(|| line.to_string())
}
