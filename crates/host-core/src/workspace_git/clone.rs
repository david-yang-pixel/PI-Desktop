//! Cloning a repository's main checkout. A clone is written to a sibling
//! temporary directory and renamed into place only on success, so an
//! interrupted clone never leaves a half-written directory where the main
//! checkout belongs.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use super::repository::{run, NetworkContext, CLONE_TIMEOUT};
use super::WorkspaceGitError;

pub(super) async fn clone(
    ctx: &NetworkContext<'_>,
    remote_url: &str,
    parent: &Path,
    name: &str,
    main_path: &Path,
) -> Result<(), WorkspaceGitError> {
    let temporary = TemporaryClone::new(parent, name);
    let Some(target) = temporary.path.to_str() else {
        return Err(WorkspaceGitError::invalid("invalid main checkout path"));
    };
    let args = [
        "clone",
        "--progress",
        "--origin",
        "origin",
        "--",
        remote_url,
        target,
    ];
    run(ctx, parent, "clone", &args, CLONE_TIMEOUT).await?;
    fs::rename(&temporary.path, main_path)?;
    temporary.keep();
    Ok(())
}

/// Temporary clones are named `<repo>.cloning-<random>.git`. No repository
/// name may end in `.git`, so the name can never be another repository's main
/// checkout in the same owner directory.
const TEMPORARY_SUFFIX: &str = ".git";

fn temporary_prefix(name: &str) -> String {
    format!("{name}.cloning-")
}

/// Remove what an interrupted clone of this repository left behind.
pub(super) fn remove_leftover_clones(parent: &Path, name: &str) -> Result<(), WorkspaceGitError> {
    let prefix = temporary_prefix(name);
    for entry in fs::read_dir(parent)? {
        let entry = entry?;
        let file_name = entry.file_name();
        let Some(file_name) = file_name.to_str() else {
            continue;
        };
        if file_name.starts_with(&prefix) && file_name.ends_with(TEMPORARY_SUFFIX) {
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

/// The directory a clone is written to until it succeeds. Dropping it (a
/// failed clone, or a cancelled job whose future is dropped) removes it.
struct TemporaryClone {
    path: PathBuf,
    keep: bool,
}

impl TemporaryClone {
    fn new(parent: &Path, name: &str) -> Self {
        let random = uuid::Uuid::new_v4().simple().to_string();
        Self {
            path: parent.join(format!(
                "{}{random}{TEMPORARY_SUFFIX}",
                temporary_prefix(name)
            )),
            keep: false,
        }
    }

    fn keep(mut self) {
        self.keep = true;
    }
}

impl Drop for TemporaryClone {
    fn drop(&mut self) {
        if self.keep {
            return;
        }
        // Best effort: a git child that outlives its killed parent may still
        // be writing; whatever remains is removed by the next `ensure`.
        if let Err(error) = remove_path(&self.path) {
            tracing::warn!(%error, "could not remove an interrupted clone directory");
        }
    }
}
