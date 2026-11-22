//! Reclaim a clean, published worktree while retaining its registered branch.

use std::collections::HashSet;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::{fs, str};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::layout::{short_id, work_branch, Layout};
use super::registry::{ReclaimIntent, SetupStatus, WorktreeRecord};
use super::{repository, worktree::pushed_floor, WorkspaceGitError};
use crate::db::{ms_to_ts, now_ms};
use crate::session_worktrees::{git::GitRunner, repo_lock};
use crate::workspace::simple_canonicalize;

const MAX_REGENERABLE_DIRS: usize = 64;
const MAX_REGENERABLE_DIR_CHARS: usize = 256;
const MAX_WORKSPACE_CONFIG_BYTES: usize = 64 * 1024;
const PROJECT_CONFIG: &str = ".pi/workspace.json";
const GIT_STATE_MARKERS: &[&str] = &[
    "MERGE_HEAD",
    "MERGE_AUTOSTASH",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "REBASE_HEAD",
    "rebase-merge",
    "rebase-apply",
    "sequencer",
    "BISECT_START",
    "BISECT_LOG",
    "index.lock",
    "HEAD.lock",
    "packed-refs.lock",
    "config.lock",
    "info/grafts",
];

type Result<T> = std::result::Result<T, WorkspaceGitError>;

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Refusal {
    Busy,
    UncommittedChanges,
    UnpushedCommits,
    ProtectedIgnoredFiles,
    GitStateUncertain,
}

#[derive(Default)]
struct Counts {
    uncommitted: u32,
    unpushed: u32,
    protected: u32,
}

impl Counts {
    fn refused(&self, reason: Refusal) -> Value {
        json!({
            "reclaimed": false,
            "reason": reason,
            "uncommittedFiles": self.uncommitted,
            "unpushedCommits": self.unpushed,
            "protectedIgnoredFiles": self.protected,
        })
    }
}

pub fn refused(reason: Refusal) -> Value {
    Counts::default().refused(reason)
}

pub fn validate_regenerable_dirs(raw_dirs: &[String]) -> Result<Vec<String>> {
    if raw_dirs.len() > MAX_REGENERABLE_DIRS {
        return Err(WorkspaceGitError::invalid(
            "too many regenerable build directories",
        ));
    }
    let mut seen = HashSet::new();
    let mut valid = Vec::with_capacity(raw_dirs.len());
    for raw in raw_dirs {
        if raw.trim().is_empty()
            || raw.chars().count() > MAX_REGENERABLE_DIR_CHARS
            || raw
                .chars()
                .any(|ch| ch.is_ascii_control() || matches!(ch, '\\' | '*' | '?' | '[' | ']' | ':'))
            || raw
                .split('/')
                .any(|part| matches!(part, "" | "." | "..") || part.eq_ignore_ascii_case(".git"))
        {
            return Err(WorkspaceGitError::invalid(
                "invalid regenerable directory path",
            ));
        }
        if seen.insert(raw) {
            valid.push(raw.clone());
        }
    }
    Ok(valid)
}

pub struct RegisteredPaths {
    pub main: PathBuf,
    pub checkout: PathBuf,
    pub common: PathBuf,
}

impl RegisteredPaths {
    pub fn verify(layout: &Layout, record: &WorktreeRecord) -> Result<Self> {
        let repository = record.repository.validated()?;
        let id = short_id(&record.installation_id, &record.session_id);
        if record.work_branch != work_branch(&record.installation_id, &record.session_id) {
            return Err(uncertain());
        }
        let layout = layout.canonical()?;
        let checkout = layout.worktree_path(&repository, &id);
        let checkout_parent = checkout.parent().ok_or_else(uncertain)?;
        let main = layout.main_path(&repository);
        let common = main.join(".git");
        if checkout != Path::new(&record.path)
            || simple_canonicalize(checkout_parent)? != checkout_parent
            || simple_canonicalize(&main)? != main
            || main != simple_canonicalize(Path::new(&record.main_path))?
            || !fs::symlink_metadata(&common)?.is_dir()
            || simple_canonicalize(&common)? != common
        {
            return Err(uncertain());
        }
        Ok(Self {
            main,
            checkout,
            common,
        })
    }
}

fn uncertain() -> WorkspaceGitError {
    WorkspaceGitError::failed("could not verify managed worktree Git or filesystem state")
}

pub fn interrupted() -> WorkspaceGitError {
    WorkspaceGitError::failed(
        "workspace recovery was interrupted and its checkout state is uncertain",
    )
}

async fn inspect_output(
    git: &GitRunner,
    cwd: &Path,
    args: &[&str],
) -> Result<crate::session_worktrees::git::GitOutput> {
    let mut hardened = vec!["--no-replace-objects"];
    hardened.extend_from_slice(args);
    let result = git
        .local_inspection(cwd, &hardened)
        .await
        .map_err(|_| uncertain())?;
    if !result.stderr.is_empty() {
        return Err(uncertain());
    }
    Ok(result)
}

async fn inspect(git: &GitRunner, cwd: &Path, args: &[&str]) -> Result<String> {
    let result = inspect_output(git, cwd, args).await?;
    if !result.success() {
        return Err(uncertain());
    }
    Ok(result.stdout)
}

fn output_line(output: &str) -> Result<&str> {
    let value = output
        .strip_suffix("\r\n")
        .or_else(|| output.strip_suffix('\n'))
        .ok_or_else(uncertain)?;
    if value.is_empty() || value.contains(['\r', '\n', '\0']) {
        return Err(uncertain());
    }
    Ok(value)
}

fn oid(value: &str) -> Result<&str> {
    if !matches!(value.len(), 40 | 64) || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(uncertain());
    }
    Ok(value)
}

pub async fn branch_commit(git: &GitRunner, root: &Path, branch: &str) -> Result<String> {
    let reference = format!("refs/heads/{branch}");
    let symbolic = inspect_output(
        git,
        root,
        &["symbolic-ref", "--quiet", "--no-recurse", &reference],
    )
    .await?;
    if symbolic.status != 1 || !symbolic.stdout.is_empty() {
        return Err(uncertain());
    }
    let output = inspect(
        git,
        root,
        &["show-ref", "--verify", "--hash", "--", &reference],
    )
    .await?;
    Ok(oid(output_line(&output)?)?.to_owned())
}

fn absent(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(false),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(error.into()),
    }
}

fn verify_dir(path: &Path) -> Result<()> {
    if !fs::symlink_metadata(path)?.is_dir() || simple_canonicalize(path)? != path {
        return Err(uncertain());
    }
    Ok(())
}

fn read_small_file(path: &Path) -> Result<String> {
    const LIMIT: u64 = 8192;
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    if !fs::symlink_metadata(path)?.is_file() {
        return Err(uncertain());
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(uncertain());
    }
    let mut text = String::new();
    file.take(LIMIT + 1).read_to_string(&mut text)?;
    if text.len() as u64 > LIMIT {
        return Err(uncertain());
    }
    Ok(text)
}

/// Verify both directions of Git's link, the actual repository and top-level,
/// and the attached work branch. A matching directory name alone is no proof.
pub async fn checkout_admin(
    git: &GitRunner,
    paths: &RegisteredPaths,
    branch: &str,
) -> Result<PathBuf> {
    let path = &paths.checkout;
    verify_dir(path)?;
    let listing = inspect(
        git,
        path,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--show-toplevel",
            "--git-common-dir",
            "--git-dir",
        ],
    )
    .await?;
    let mut lines = listing.lines();
    if lines
        .next()
        .map(Path::new)
        .map(simple_canonicalize)
        .transpose()?
        .as_ref()
        != Some(path)
        || lines
            .next()
            .map(Path::new)
            .map(simple_canonicalize)
            .transpose()?
            .as_ref()
            != Some(&paths.common)
    {
        return Err(uncertain());
    }
    let reported_admin = Path::new(lines.next().ok_or_else(uncertain)?);
    let admin = simple_canonicalize(reported_admin)?;
    let admin_root = paths.common.join("worktrees");
    verify_dir(&admin_root)?;
    verify_dir(&admin)?;
    if lines.next().is_some()
        || admin.parent() != Some(admin_root.as_path())
        || !fs::symlink_metadata(reported_admin)?.is_dir()
    {
        return Err(uncertain());
    }
    let link_file = path.join(".git");
    let forward = read_small_file(&link_file)?;
    let target = Path::new(
        output_line(&forward)?
            .strip_prefix("gitdir: ")
            .ok_or_else(uncertain)?,
    );
    if simple_canonicalize(&path.join(target))? != admin {
        return Err(uncertain());
    }
    let backlink = read_small_file(&admin.join("gitdir"))?;
    if simple_canonicalize(&admin.join(output_line(&backlink)?))? != link_file {
        return Err(uncertain());
    }
    let attached = inspect(git, path, &["symbolic-ref", "--no-recurse", "HEAD"]).await?;
    if output_line(&attached)? != format!("refs/heads/{branch}") {
        return Err(uncertain());
    }
    Ok(admin)
}

async fn verify_main(git: &GitRunner, paths: &RegisteredPaths) -> Result<()> {
    verify_dir(&paths.common)?;
    let git_dir = inspect(git, &paths.main, &["rev-parse", "--absolute-git-dir"]).await?;
    let top_level = inspect(git, &paths.main, &["rev-parse", "--show-toplevel"]).await?;
    if simple_canonicalize(Path::new(output_line(&git_dir)?))? != paths.common
        || simple_canonicalize(Path::new(output_line(&top_level)?))? != paths.main
    {
        return Err(uncertain());
    }
    Ok(())
}

pub async fn verify_retained_branch(
    git: &GitRunner,
    paths: &RegisteredPaths,
    record: &WorktreeRecord,
) -> Result<()> {
    verify_main(git, paths).await?;
    let current = branch_commit(git, &paths.main, &record.work_branch).await?;
    match (
        &record.recovery.reclaimed_at,
        &record.recovery.reclaimed_commit,
    ) {
        (None, None) => Ok(()),
        (Some(_), Some(expected)) if expected == &current => Ok(()),
        _ => Err(WorkspaceGitError::failed(
            "the retained workspace branch has moved or its reclaim record is incomplete",
        )),
    }
}

pub async fn restore_checkout(
    git: &GitRunner,
    paths: &RegisteredPaths,
    record: &WorktreeRecord,
) -> Result<()> {
    let path = paths.checkout.to_str().ok_or_else(uncertain)?;
    git.run(
        &paths.main,
        &[
            "worktree",
            "add",
            "-q",
            "--lock",
            "--reason",
            "pi-desktop session worktree",
            "--",
            path,
            &record.work_branch,
        ],
    )
    .await
    .map_err(|error| repository::from_git_error("worktree add", error))?;
    checkout_admin(git, paths, &record.work_branch).await?;
    verify_retained_branch(git, paths, record).await
}

fn split_records(text: &str) -> Result<impl Iterator<Item = &str>> {
    Ok(if text.is_empty() {
        text
    } else {
        text.strip_suffix('\0').ok_or_else(uncertain)?
    }
    .split_terminator('\0'))
}

fn repo_relative(path: &str) -> Result<&str> {
    let path = path.strip_suffix('/').unwrap_or(path);
    if path.is_empty()
        || path
            .split('/')
            .any(|part| matches!(part, "" | "." | "..") || part.contains('\\'))
    {
        return Err(uncertain());
    }
    Ok(path)
}

async fn verify_index(git: &GitRunner, checkout: &Path) -> Result<()> {
    let sparse = inspect(
        git,
        checkout,
        &[
            "config",
            "--type=bool",
            "--default=false",
            "--get",
            "core.sparseCheckout",
        ],
    )
    .await?;
    if output_line(&sparse)? != "false" {
        return Err(uncertain());
    }
    // Lowercase tags indicate assume-unchanged. S is skip-worktree. Refuse
    // both, plus staged conflicts, gitlinks and unknown index representations.
    let entries = inspect(git, checkout, &["ls-files", "-v", "--stage", "-z"]).await?;
    for entry in split_records(&entries)? {
        let (header, path) = entry.split_once('\t').ok_or_else(uncertain)?;
        repo_relative(path)?;
        let mut fields = header.split(' ');
        if fields.next() != Some("H")
            || !matches!(fields.next(), Some("100644" | "100755" | "120000"))
        {
            return Err(uncertain());
        }
        oid(fields.next().ok_or_else(uncertain)?)?;
        if fields.next() != Some("0") || fields.next().is_some() {
            return Err(uncertain());
        }
    }
    Ok(())
}

#[derive(Deserialize)]
struct ProjectConfig {
    #[serde(default)]
    reclaim: ReclaimConfig,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReclaimConfig {
    #[serde(default)]
    regenerable_dirs: Vec<String>,
}

async fn project_dirs(git: &GitRunner, checkout: &Path, commit: &str) -> Result<Vec<String>> {
    // Read the committed regular blob only. A local ignored config, symlink,
    // or Git filter cannot grant permission to remove additional files.
    let tree = inspect(
        git,
        checkout,
        &["ls-tree", "-z", commit, "--", PROJECT_CONFIG],
    )
    .await?;
    let mut entries = split_records(&tree)?;
    let Some(entry) = entries.next() else {
        return Ok(Vec::new());
    };
    let (header, path) = entry.split_once('\t').ok_or_else(uncertain)?;
    let mut fields = header.split(' ');
    if path != PROJECT_CONFIG
        || entries.next().is_some()
        || !matches!(fields.next(), Some("100644" | "100755"))
        || fields.next() != Some("blob")
    {
        return Err(uncertain());
    }
    let object = oid(fields.next().ok_or_else(uncertain)?)?;
    if fields.next().is_some() {
        return Err(uncertain());
    }
    let size = inspect(git, checkout, &["cat-file", "-s", object]).await?;
    let size: usize = output_line(&size)?.parse().map_err(|_| uncertain())?;
    if size > MAX_WORKSPACE_CONFIG_BYTES {
        return Err(uncertain());
    }
    let content = inspect(git, checkout, &["cat-file", "blob", object]).await?;
    if content.len() != size {
        return Err(uncertain());
    }
    let config: ProjectConfig = serde_json::from_str(&content).map_err(|_| uncertain())?;
    validate_regenerable_dirs(&config.reclaim.regenerable_dirs)
}

fn approved_ignored(checkout: &Path, path: &str, declared: &[String]) -> Result<bool> {
    // A covering ignored directory can hide an untracked project config.
    if path == PROJECT_CONFIG
        || PROJECT_CONFIG
            .strip_prefix(path)
            .is_some_and(|tail| tail.starts_with('/'))
    {
        return Ok(false);
    }
    let mut end = 0;
    for segment in path.split('/') {
        end += segment.len();
        let prefix = &path[..end];
        if (segment == "node_modules" || declared.iter().any(|dir| dir == prefix))
            && fs::symlink_metadata(checkout.join(prefix))?.is_dir()
        {
            return Ok(true);
        }
        end += 1;
    }
    Ok(false)
}

fn count_status(checkout: &Path, status: &str, dirs: &[String]) -> Result<Counts> {
    let mut counts = Counts::default();
    let mut entries = split_records(status)?;
    while let Some(entry) = entries.next() {
        let (flags, path) = entry.get(..3).zip(entry.get(3..)).ok_or_else(uncertain)?;
        let path = repo_relative(path)?;
        if flags == "!! " {
            if !approved_ignored(checkout, path, dirs)? {
                counts.protected = counts.protected.saturating_add(1);
            }
            continue;
        }
        let flags = flags.as_bytes();
        if flags[2] != b' '
            || (flags[..2] != *b"??" && !flags[..2].iter().all(|flag| b" MTADRCU".contains(flag)))
        {
            return Err(uncertain());
        }
        if flags[..2].iter().any(|flag| matches!(flag, b'R' | b'C')) {
            repo_relative(entries.next().ok_or_else(uncertain)?)?;
        }
        counts.uncommitted = counts.uncommitted.saturating_add(1);
    }
    Ok(counts)
}

#[cfg(target_os = "linux")]
fn verify_mounts(root: &Path) -> Result<()> {
    use std::os::unix::ffi::OsStrExt;
    // st_dev alone misses bind mounts on the same filesystem, including bind
    // mounts of a single file. mountinfo escapes whitespace and backslashes.
    let prefix = root.as_os_str().as_bytes();
    for line in fs::read("/proc/self/mountinfo")?
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
    {
        let mount = line
            .split(|byte| *byte == b' ')
            .nth(4)
            .ok_or_else(uncertain)?;
        let mut decoded = Vec::with_capacity(mount.len());
        let mut cursor = 0;
        while cursor < mount.len() {
            if mount[cursor] == b'\\' {
                let encoded = mount.get(cursor + 1..cursor + 4).ok_or_else(uncertain)?;
                let octal = str::from_utf8(encoded).map_err(|_| uncertain())?;
                decoded.push(u8::from_str_radix(octal, 8).map_err(|_| uncertain())?);
                cursor += 4;
            } else {
                decoded.push(mount[cursor]);
                cursor += 1;
            }
        }
        if decoded == prefix
            || decoded
                .strip_prefix(prefix)
                .is_some_and(|tail| tail.starts_with(b"/"))
        {
            return Err(uncertain());
        }
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn verify_mounts(_root: &Path) -> Result<()> {
    Ok(())
}

fn verify_removal_tree(root: &Path, checkout: bool) -> Result<()> {
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    #[cfg(windows)]
    use std::os::windows::fs::MetadataExt;
    verify_dir(root)?;
    verify_mounts(root)?;
    #[cfg(unix)]
    let device = fs::symlink_metadata(root.parent().ok_or_else(uncertain)?)?.dev();
    let mut dirs = vec![root.to_owned()];
    while let Some(dir) = dirs.pop() {
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let metadata = fs::symlink_metadata(entry.path())?;
            #[cfg(unix)]
            if metadata.dev() != device {
                return Err(uncertain());
            }
            #[cfg(windows)]
            if metadata.file_attributes() & 0x400 != 0 {
                return Err(uncertain());
            }
            let name = entry.file_name();
            let name = name.to_str().ok_or_else(uncertain)?;
            if checkout && dir != root && name.eq_ignore_ascii_case(".git") {
                return Err(uncertain());
            }
            if metadata.is_dir() {
                dirs.push(entry.path());
            } else if !metadata.is_file() && !metadata.file_type().is_symlink() {
                return Err(uncertain());
            }
        }
    }
    Ok(())
}

struct VerifiedReclaim {
    commit: String,
    admin: PathBuf,
    counts: Counts,
    allowed_dirs: Vec<String>,
}

async fn status_without_filters(git: &GitRunner, checkout: &Path) -> Result<String> {
    // A clean filter can execute a process or turn edited bytes into the same
    // blob. Inspect with configured clean/process drivers disabled, so their
    // transformed files are refused when Git can no longer prove them clean.
    let filters = inspect_output(
        git,
        checkout,
        &[
            "config",
            "--name-only",
            "--null",
            "--get-regexp",
            r"^filter\..*\.(clean|process|required)$",
        ],
    )
    .await?;
    if !(filters.success() || (filters.status == 1 && filters.stdout.is_empty())) {
        return Err(uncertain());
    }
    let mut overrides = Vec::new();
    for key in split_records(&filters.stdout)? {
        let (driver, property) = key.rsplit_once('.').ok_or_else(uncertain)?;
        let value = match property {
            "clean" | "process" => "",
            "required" => "false",
            _ => return Err(uncertain()),
        };
        if !driver.starts_with("filter.") || key.contains(['=', '\r', '\n']) {
            return Err(uncertain());
        }
        overrides.push(format!("{key}={value}"));
    }
    let mut args = Vec::new();
    for entry in &overrides {
        args.extend(["-c", entry]);
    }
    #[cfg(unix)]
    args.extend(["-c", "core.fileMode=true"]);
    args.extend([
        "-c",
        "core.ignoreStat=false",
        "-c",
        "core.trustctime=true",
        "-c",
        "core.checkStat=default",
        "-c",
        "core.untrackedCache=false",
        "status",
        "--porcelain=v1",
        "-z",
        "--ignored=matching",
        "--untracked-files=all",
        "--ignore-submodules=none",
        "--no-renames",
    ]);
    inspect(git, checkout, &args).await
}

async fn check(
    git: &GitRunner,
    paths: &RegisteredPaths,
    record: &WorktreeRecord,
    mut extra_dirs: Vec<String>,
) -> Result<VerifiedReclaim> {
    let branch = record.work_branch.as_str();
    verify_main(git, paths).await?;
    let admin = checkout_admin(git, paths, branch).await?;
    for dir in [&admin, &paths.common] {
        for marker in GIT_STATE_MARKERS {
            if !absent(&dir.join(marker))? {
                return Err(uncertain());
            }
        }
    }
    if !absent(&paths.common.join(format!("refs/heads/{branch}.lock")))? {
        return Err(uncertain());
    }
    verify_index(git, &paths.checkout).await?;
    let commit = branch_commit(git, &paths.main, branch).await?;
    let head = inspect(
        git,
        &paths.checkout,
        &["rev-parse", "--verify", "HEAD^{commit}"],
    )
    .await?;
    if output_line(&head)? != commit {
        return Err(uncertain());
    }
    extra_dirs.extend(project_dirs(git, &paths.checkout, &commit).await?);
    let output = status_without_filters(git, &paths.checkout).await?;
    let mut counts = count_status(&paths.checkout, &output, &extra_dirs)?;
    let floor = pushed_floor(git, &paths.main, record.last_pushed_commit.as_deref()).await;
    let mut args = vec!["rev-list", "--count", commit.as_str(), "--not"];
    args.extend(["--remotes=origin"].into_iter().chain(floor.as_deref()));
    let unpushed = inspect(git, &paths.main, &args).await?;
    counts.unpushed = output_line(&unpushed)?.parse().map_err(|_| uncertain())?;
    if counts.uncommitted == 0 && counts.unpushed == 0 && counts.protected == 0 {
        verify_removal_tree(&paths.checkout, true)?;
        verify_removal_tree(&admin, false)?;
    }
    Ok(VerifiedReclaim {
        commit,
        admin,
        counts,
        allowed_dirs: extra_dirs,
    })
}

pub fn quarantine_path(checkout: &Path, intent: &ReclaimIntent) -> Result<PathBuf> {
    let id = uuid::Uuid::parse_str(&intent.quarantine_id).map_err(|_| interrupted())?;
    Ok(checkout.with_file_name(format!(".pi-reclaim-{id}")))
}

fn admin_path(common: &Path, intent: &ReclaimIntent) -> Result<PathBuf> {
    let mut parts = Path::new(&intent.admin_name).components();
    if !matches!(parts.next(), Some(Component::Normal(_))) || parts.next().is_some() {
        return Err(interrupted());
    }
    Ok(common.join("worktrees").join(&intent.admin_name))
}

/// A surviving quarantine may be partly emptied. Only finalize a pending
/// reclaim when the persisted post-rename checkpoint and disk agree that
/// both it and the verified admin entry are gone.
pub fn verify_completed_intent(paths: &RegisteredPaths, intent: &ReclaimIntent) -> Result<()> {
    if !intent.quarantined
        || !absent(&paths.checkout)?
        || !absent(&quarantine_path(&paths.checkout, intent)?)?
        || !absent(&admin_path(&paths.common, intent)?)?
    {
        return Err(interrupted());
    }
    Ok(())
}

#[cfg(unix)]
fn sync_parent(path: &Path) -> Result<()> {
    fs::File::open(path.parent().ok_or_else(uncertain)?)?.sync_all()?;
    Ok(())
}

#[cfg(not(unix))]
fn sync_parent(_path: &Path) -> Result<()> {
    Ok(())
}

fn reclaimed(record: &WorktreeRecord, already: bool) -> Result<Value> {
    let commit = record
        .recovery
        .reclaimed_commit
        .as_deref()
        .ok_or_else(interrupted)?;
    let timestamp = record
        .recovery
        .reclaimed_at
        .as_deref()
        .ok_or_else(interrupted)?;
    let mut value = json!({ "reclaimed": true, "commit": commit, "reclaimedAt": timestamp });
    if already {
        value["alreadyReclaimed"] = json!(true);
    }
    Ok(value)
}

/// Called with the repository lock after the recovery record is complete.
#[cfg(unix)]
async fn compact_shared_objects(git: &GitRunner, paths: &RegisteredPaths) -> Result<()> {
    let objects = paths.common.join("objects");
    let pack = objects.join("pack");
    verify_dir(&objects)?;
    verify_dir(&pack)?;
    verify_dir(&objects.join("info"))?;
    verify_mounts(&objects)?;
    if !absent(&objects.join("info/alternates"))? || !absent(&objects.join("info/http-alternates"))?
    {
        return Err(uncertain());
    }
    // Git traverses the loose-object fanout directories when dropping copies
    // already in packs. Do not let that traversal reach another object store.
    for entry in fs::read_dir(&objects)? {
        if entry?.file_type()?.is_symlink() {
            return Err(uncertain());
        }
    }
    // A redirected pack could make Git consider a local loose object
    // redundant even though its only packed copy is outside this repository.
    for entry in fs::read_dir(&pack)? {
        if !entry?.file_type()?.is_file() {
            return Err(uncertain());
        }
    }
    // The incremental form packs loose objects and removes redundant loose
    // copies. It does not expire objects, reflogs, or worktree metadata.
    let output = git
        .run_local_with_timeout(
            &paths.main,
            &[
                "--no-replace-objects",
                "repack",
                "-d",
                "-n",
                "-l",
                "-q",
                "--no-write-bitmap-index",
                "--threads=2",
                "--window-memory=32m",
            ],
            std::time::Duration::from_secs(5),
        )
        .await
        .map_err(|error| repository::from_git_error("repack", error))?;
    if !output.success() {
        return Err(WorkspaceGitError::failed(format!(
            "git repack exited with status {}",
            output.status
        )));
    }
    Ok(())
}

/// The caller holds the exclusive session guard for the entire operation.
/// Each persist commits the complete record before the next destructive step.
pub async fn execute<F>(
    git: &GitRunner,
    layout: &Layout,
    mut record: WorktreeRecord,
    extra_dirs: Vec<String>,
    persist: impl Fn(WorktreeRecord) -> F,
) -> Result<Value>
where
    F: std::future::Future<Output = Result<()>> + Send,
{
    let paths = match RegisteredPaths::verify(layout, &record) {
        Ok(paths) => paths,
        Err(_) if !record.recovery.blocks_access() => {
            return Ok(refused(Refusal::GitStateUncertain))
        }
        Err(error) => return Err(error),
    };
    let Some(_repository) = repo_lock::try_lock(&paths.common) else {
        return Ok(refused(Refusal::Busy));
    };
    if record.recovery.blocks_access() {
        if record.recovery.strict_setup_pending || record.recovery.checkout_creation_pending {
            return Err(interrupted());
        }
        verify_main(git, &paths).await?;
        let current = branch_commit(git, &paths.main, &record.work_branch).await?;
        if record.recovery.reclaimed_commit.as_deref() != Some(&current)
            || !absent(&paths.checkout)?
        {
            return Err(interrupted());
        }
        if let Some(intent) = &record.recovery.reclaim_intent {
            verify_completed_intent(&paths, intent)?;
            record.recovery.reclaim_intent = None;
            record.setup_status = SetupStatus::None;
            record.setup_log_tail = None;
            persist(record.clone()).await?;
        }
        return reclaimed(&record, true);
    }
    if record.setup_status == SetupStatus::Running {
        return Ok(refused(Refusal::Busy));
    }
    let VerifiedReclaim {
        commit,
        admin,
        counts,
        allowed_dirs,
    } = match check(git, &paths, &record, extra_dirs).await {
        Ok(checked) => checked,
        Err(error) => {
            tracing::debug!(%error, "could not verify workspace reclaim safety");
            return Ok(refused(Refusal::GitStateUncertain));
        }
    };
    let reason = if counts.uncommitted > 0 {
        Some(Refusal::UncommittedChanges)
    } else if counts.unpushed > 0 {
        Some(Refusal::UnpushedCommits)
    } else if counts.protected > 0 {
        Some(Refusal::ProtectedIgnoredFiles)
    } else {
        None
    };
    if let Some(reason) = reason {
        return Ok(counts.refused(reason));
    }
    // A concurrent external Git command is outside the managed locks. Check
    // the retained ref once more before recording the intent.
    if !branch_commit(git, &paths.main, &record.work_branch)
        .await
        .is_ok_and(|current| current == commit)
    {
        return Ok(refused(Refusal::GitStateUncertain));
    }
    let mut intent = ReclaimIntent {
        quarantine_id: uuid::Uuid::new_v4().to_string(),
        admin_name: admin
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(uncertain)?
            .to_owned(),
        quarantined: false,
    };
    let quarantine = quarantine_path(&paths.checkout, &intent)?;
    record.recovery.reclaimed_at = Some(ms_to_ts(now_ms()));
    record.recovery.reclaimed_commit = Some(commit);
    record.recovery.reclaim_intent = Some(intent.clone());
    persist(record.clone()).await?;

    // A freshly created private container gives rename an unoccupied target
    // on the same filesystem. Recursive deletion never runs at the live path.
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&quarantine)?;
    let quarantined_checkout = quarantine.join("checkout");
    fs::rename(&paths.checkout, &quarantined_checkout)?;
    sync_parent(&quarantined_checkout)?;
    sync_parent(&paths.checkout)?;
    intent.quarantined = true;
    record.recovery.reclaim_intent = Some(intent);
    persist(record.clone()).await?;

    // The moved checkout still points to its original index. Recheck its
    // contents before deletion in case an external process wrote to it while
    // the first filesystem inspection was running.
    verify_index(git, &quarantined_checkout).await?;
    let status = status_without_filters(git, &quarantined_checkout).await?;
    let counts = count_status(&quarantined_checkout, &status, &allowed_dirs)?;
    if counts.uncommitted > 0 || counts.protected > 0 {
        return Err(interrupted());
    }
    verify_retained_branch(git, &paths, &record).await?;

    tokio::task::spawn_blocking(move || -> Result<()> {
        verify_removal_tree(&quarantined_checkout, true)?;
        verify_removal_tree(&admin, false)?;
        fs::remove_dir_all(&quarantined_checkout)?;
        fs::remove_dir(&quarantine)?;
        sync_parent(&quarantine)?;
        fs::remove_dir_all(&admin)?;
        sync_parent(&admin)?;
        Ok(())
    })
    .await
    .map_err(|_| interrupted())??;
    if !absent(&paths.checkout)?
        || record.recovery.reclaimed_commit.as_deref()
            != Some(
                branch_commit(git, &paths.main, &record.work_branch)
                    .await?
                    .as_str(),
            )
    {
        return Err(interrupted());
    }
    record.recovery.reclaim_intent = None;
    record.setup_status = SetupStatus::None;
    record.setup_log_tail = None;
    persist(record.clone()).await?;
    #[cfg(unix)]
    if let Err(error) = compact_shared_objects(git, &paths).await {
        tracing::warn!(%error, "could not compact shared workspace Git objects after reclaim");
    }
    reclaimed(&record, false)
}
