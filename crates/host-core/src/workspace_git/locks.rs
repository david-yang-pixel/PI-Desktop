//! Shared tool access and exclusive Git operations for a managed worktree.
//! Keys are stable before creation and after reclamation.
//!
//! Also the repository-level locks of remote git workspaces:
//!
//! - the repository lock (`session_worktrees::repo_lock`, keyed by the main
//!   checkout's git directory) serializes the local steps that change a
//!   repository's refs and worktree metadata: worktree creation, restore,
//!   rollback, removal, and reclaim. None of them waits on the network;
//! - the transfer lock serializes a repository's clone and fetch among
//!   themselves, so the repository lock is not held for as long as the
//!   network takes. A push holds neither (`workspace_git::push`).

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use tokio::sync::{OwnedMutexGuard, OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};

use super::WorkspaceGitError;
use crate::session_worktrees::repo_lock;

/// How long a request answered inline (removal) waits for another step of
/// the same repository before it answers `WORKSPACE_GIT_BUSY`, well inside
/// the request's own budget.
#[cfg(not(test))]
const REPOSITORY_WAIT: Duration = Duration::from_secs(5);
#[cfg(test)]
const REPOSITORY_WAIT: Duration = Duration::from_millis(300);

/// How a step waits for the repository lock.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Wait {
    /// A job: wait as long as it takes.
    Block,
    /// A request answered inline: give up after a moment with
    /// `WORKSPACE_GIT_BUSY`, which the caller retries.
    Bounded,
}

pub fn repository_busy() -> WorkspaceGitError {
    WorkspaceGitError::new(
        "WORKSPACE_GIT_BUSY",
        "another git operation on this repository is still running; try again shortly",
    )
}

/// The repository lock of the git directory `common`.
pub async fn repository(
    common: &Path,
    wait: Wait,
) -> Result<OwnedMutexGuard<()>, WorkspaceGitError> {
    match wait {
        Wait::Block => Ok(repo_lock::lock(common).await),
        Wait::Bounded => tokio::time::timeout(REPOSITORY_WAIT, repo_lock::lock(common))
            .await
            .map_err(|_| repository_busy()),
    }
}

/// The transfer lock of the git directory `common`: a separate key, so it
/// never excludes the repository lock.
pub async fn transfer(common: &Path) -> OwnedMutexGuard<()> {
    repo_lock::lock(&common.join("pi-desktop-transfer")).await
}

#[derive(Clone, Default)]
pub struct WorktreeAccessLocks {
    inner: Arc<Mutex<HashMap<String, Weak<RwLock<()>>>>>,
}

impl WorktreeAccessLocks {
    fn lock_for(&self, installation: &str, session: &str) -> Arc<RwLock<()>> {
        let key = super::layout::short_id(installation, session);
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.retain(|_, weak| weak.strong_count() > 0);
        if let Some(existing) = guard.get(&key).and_then(Weak::upgrade) {
            return existing;
        }
        let created = Arc::new(RwLock::new(()));
        guard.insert(key, Arc::downgrade(&created));
        created
    }

    pub fn try_read(&self, installation: &str, session: &str) -> Option<OwnedRwLockReadGuard<()>> {
        self.lock_for(installation, session).try_read_owned().ok()
    }

    pub fn try_write(
        &self,
        installation: &str,
        session: &str,
    ) -> Option<OwnedRwLockWriteGuard<()>> {
        self.lock_for(installation, session).try_write_owned().ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_bounded_wait_gives_up_and_the_transfer_lock_is_separate() {
        let common = Path::new("/locks-test/repo/.git");
        let held = repository(common, Wait::Block).await.unwrap();
        let error = repository(common, Wait::Bounded).await.unwrap_err();
        assert_eq!(error.code, "WORKSPACE_GIT_BUSY");
        // A clone or fetch of the repository is not held up by it.
        let transfer = tokio::time::timeout(Duration::from_secs(5), transfer(common))
            .await
            .unwrap();
        drop(held);
        assert!(repository(common, Wait::Bounded).await.is_ok());
        drop(transfer);
    }

    #[test]
    fn readers_exclude_writers_for_the_same_session() {
        let locks = WorktreeAccessLocks::default();
        let first = locks.try_read("install", "session").unwrap();
        let second = locks.try_read("install", "session").unwrap();
        assert!(locks.try_write("install", "session").is_none());
        assert!(locks.try_write("install", "different").is_some());
        drop(first);
        assert!(locks.try_write("install", "session").is_none());
        drop(second);
        let writer = locks.try_write("install", "session").unwrap();
        assert!(locks.try_read("install", "session").is_none());
        drop(writer);
        assert!(locks.try_write("install", "session").is_some());
    }
}
