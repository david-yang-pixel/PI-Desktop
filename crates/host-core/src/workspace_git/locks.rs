//! Shared tool access and exclusive Git operations for a managed worktree.
//! Keys are stable before creation and after reclamation.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};

use tokio::sync::{OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};

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
