//! Pushing a session's work branch to `origin`.
//!
//! A push is planned and sent in two steps. Planning resolves the commit to
//! send while the caller holds the session's exclusive guard, and takes a
//! moment. The transfer then sends exactly that commit, `<oid>:refs/heads/<work>`,
//! without the guard and without the repository lock: tools can keep working
//! in the worktree, and other sessions of the repository are not held up for
//! as long as the network takes. The running push job still keeps prepare,
//! remove, and reclaim of the same session away.

use std::path::Path;

use super::layout::validate_branch;
use super::repository::{self, NetworkContext, PUSH_TIMEOUT};
use super::WorkspaceGitError;
use crate::session_worktrees::git::GitRunner;

/// What a push sends.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushPlan {
    /// The commit `refs/heads/<work>` pointed at when the push was planned.
    pub commit: String,
    /// `refs/remotes/origin/<work>` as this host last pushed or fetched it.
    pub remote_tracking: Option<String>,
}

/// A full object id as git prints it.
pub(crate) fn is_object_id(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// The commit `reference` names, or `None` when it does not exist.
async fn resolve(
    git: &GitRunner,
    dir: &Path,
    reference: &str,
) -> Result<Option<String>, WorkspaceGitError> {
    let output = git
        .output(
            dir,
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                "--end-of-options",
                &format!("{reference}^{{commit}}"),
            ],
        )
        .await
        .map_err(|error| repository::from_git_error("rev-parse", error))?;
    match output.status {
        0 => {
            let oid = output.stdout.trim();
            if is_object_id(oid) {
                Ok(Some(oid.to_string()))
            } else {
                Err(WorkspaceGitError::failed(
                    "git returned an unreadable commit",
                ))
            }
        }
        1 => Ok(None),
        _ => Err(WorkspaceGitError::failed(format!(
            "could not resolve {reference}"
        ))),
    }
}

/// Resolve the work branch and its remote-tracking ref. Read-only.
pub async fn plan(
    git: &GitRunner,
    worktree_path: &Path,
    work_branch: &str,
) -> Result<PushPlan, WorkspaceGitError> {
    validate_branch(work_branch)?;
    let commit = resolve(git, worktree_path, &format!("refs/heads/{work_branch}"))
        .await?
        .ok_or_else(|| WorkspaceGitError::failed("the work branch does not exist on the host"))?;
    let remote_tracking = resolve(
        git,
        worktree_path,
        &format!("refs/remotes/origin/{work_branch}"),
    )
    .await?;
    Ok(PushPlan {
        commit,
        remote_tracking,
    })
}

/// Push `plan.commit` to `refs/heads/<work_branch>` on `origin`, and only
/// there; returns the commit the remote branch now has.
pub async fn push(
    ctx: &NetworkContext<'_>,
    worktree_path: &Path,
    work_branch: &str,
    plan: &PushPlan,
) -> Result<String, WorkspaceGitError> {
    validate_branch(work_branch)?;
    if !is_object_id(&plan.commit) {
        return Err(WorkspaceGitError::invalid(
            "the commit to push is not an object id",
        ));
    }
    let refspec = format!("{}:refs/heads/{work_branch}", plan.commit);
    let args = ["push", "--progress", "--", "origin", refspec.as_str()];
    repository::run(ctx, worktree_path, "push", &args, PUSH_TIMEOUT).await?;
    Ok(plan.commit.clone())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::session_worktrees::repo_lock;
    use crate::workspace_git::repository::ensure;
    use crate::workspace_git::test_support::{commit_file, rev_parse, Remote};
    use crate::workspace_git::worktree::{create, StartPoint};

    const WORK: &str = "pi-desktop/aaaaaaaaaaaa";

    struct Fixture {
        _dir: tempfile::TempDir,
        remote: Remote,
        git: GitRunner,
        main: PathBuf,
        worktree: PathBuf,
    }

    impl Fixture {
        async fn new() -> Fixture {
            let dir = tempfile::tempdir().unwrap();
            let remote = Remote::new(dir.path());
            let git = GitRunner::default();
            let root = dir.path().join("root");
            let main = root.join("repos/github.com/octo/repo");
            ensure(&context(&git), &remote.url(), &main, &|_| {})
                .await
                .unwrap();
            let worktree = root.join("worktrees/github.com/octo/repo/aaaaaaaaaaaa");
            create(
                &git,
                &main,
                &worktree,
                WORK,
                StartPoint::RemoteBranch("main"),
            )
            .await
            .unwrap();
            Fixture {
                _dir: dir,
                remote,
                git,
                main,
                worktree,
            }
        }

        async fn push(&self) -> Result<String, WorkspaceGitError> {
            let plan = plan(&self.git, &self.worktree, WORK).await?;
            push(&context(&self.git), &self.worktree, WORK, &plan).await
        }
    }

    fn context(git: &GitRunner) -> NetworkContext<'_> {
        NetworkContext {
            git,
            config: &[],
            on_progress: None,
        }
    }

    #[tokio::test]
    async fn push_sends_only_the_work_branch() {
        let f = Fixture::new().await;
        let main_before = f.remote.head("main");
        let head = commit_file(&f.worktree, "work.txt", "work\n");
        assert!(!f.remote.has_branch(WORK));
        assert_eq!(f.push().await.unwrap(), head);
        assert_eq!(f.remote.head(WORK), head);
        assert_eq!(f.remote.head("main"), main_before);
        // The remote-tracking ref follows, as for a push by name.
        assert_eq!(
            rev_parse(&f.main, &format!("refs/remotes/origin/{WORK}")),
            head
        );
        // Pushing again with nothing new still reports the remote head.
        assert_eq!(f.push().await.unwrap(), head);
    }

    #[tokio::test]
    async fn the_planned_commit_is_sent_even_if_the_branch_moves_meanwhile() {
        let f = Fixture::new().await;
        let planned = commit_file(&f.worktree, "one.txt", "1\n");
        let plan = plan(&f.git, &f.worktree, WORK).await.unwrap();
        assert_eq!(
            plan,
            PushPlan {
                commit: planned.clone(),
                remote_tracking: None,
            }
        );
        // A tool commits while the transfer would run.
        let later = commit_file(&f.worktree, "two.txt", "2\n");
        assert_eq!(
            push(&context(&f.git), &f.worktree, WORK, &plan)
                .await
                .unwrap(),
            planned
        );
        assert_eq!(f.remote.head(WORK), planned);
        assert_eq!(rev_parse(&f.worktree, "HEAD"), later);
        let replanned = super::plan(&f.git, &f.worktree, WORK).await.unwrap();
        assert_eq!(replanned.remote_tracking.as_deref(), Some(planned.as_str()));
    }

    #[tokio::test]
    async fn a_push_holds_no_repository_lock() {
        let f = Fixture::new().await;
        commit_file(&f.worktree, "work.txt", "work\n");
        let common = repository::common_dir(&f.main);
        // Another step of the repository holds its lock; the push still runs.
        let held = repo_lock::lock(&common).await;
        let pushed = tokio::time::timeout(std::time::Duration::from_secs(60), f.push())
            .await
            .expect("the push waited for the repository lock");
        drop(held);
        assert_eq!(pushed.unwrap(), f.remote.head(WORK));
    }

    #[tokio::test]
    async fn a_push_that_would_lose_remote_commits_is_rejected_with_a_typed_code() {
        let f = Fixture::new().await;
        // Someone else put a commit on the remote work branch.
        let theirs = f.remote.create_branch(WORK, "develop");
        commit_file(&f.worktree, "work.txt", "work\n");
        let error = f.push().await.unwrap_err();
        assert_eq!(error.code, "WORKSPACE_GIT_PUSH_REJECTED", "{error}");
        assert_eq!(f.remote.head(WORK), theirs);
    }

    #[test]
    fn only_full_object_ids_are_pushed() {
        assert!(is_object_id(&"a".repeat(40)));
        assert!(is_object_id(&"0".repeat(64)));
        for bad in [
            "",
            "-x",
            &"A".repeat(40),
            &"a".repeat(39),
            "refs/heads/main",
        ] {
            assert!(!is_object_id(bad), "{bad}");
        }
    }
}
