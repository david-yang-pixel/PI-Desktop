//! `workspaceGit.*`: git workspaces on a remote host (D687, decision record
//! `remote-git-workspaces`).
//!
//! `pi-host` calls these on behalf of a paired desktop that holds the owner
//! role. Callers name a repository and a session; no method accepts a worktree
//! path, and every name is re-validated here before a directory is created or
//! git is started. Clone, fetch, worktree creation, the setup script, and push
//! run as jobs the caller polls, so no request waits on git.
//!
//! The GitHub token never reaches this process. Network git is pointed at the
//! loopback credential proxy `pi-host` runs, by one per-command rewrite.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::{watch, Mutex};

use super::{command_shell_catalog, rpc_err, JsonRpcError};
use crate::session_worktrees::git::GitRunner;
use crate::session_worktrees::remove::is_real_dir;
use crate::state::AppState;
use crate::workspace_git::environment::{self, parse_proxy_url};
use crate::workspace_git::jobs::{
    self, JobKind, JobPhase, JobProgress, JobState, Outcome, Pushed, SharedJobs,
};
use crate::workspace_git::layout::{
    short_id, validate_branch, validate_installation_id, validate_session_id,
    validate_variable_name, work_branch, Layout, Repository,
};
use crate::workspace_git::reclaim::{self, Refusal, RegisteredPaths};
use crate::workspace_git::registry::{self, SetupStatus, Variable, WorktreeRecord};
use crate::workspace_git::repository::{self, NetworkContext, Phase};
use crate::workspace_git::rollback;
use crate::workspace_git::setup::{self, SetupRun};
use crate::workspace_git::worktree::{self, StartPoint};
use crate::workspace_git::WorkspaceGitError;

mod prepare;
use prepare::start_prepare;

type SharedState = Arc<Mutex<AppState>>;

/// Numeric JSON-RPC code shared by every `WORKSPACE_GIT_*` error; `errorCode`
/// carries the specific reason.
const WORKSPACE_GIT_RPC_CODE: i64 = 1027;

/// Limits of the shared contract (`racp-workspace-git.ts`).
const MAX_VARIABLES: usize = 64;
const MAX_VARIABLE_VALUE_CHARS: usize = 8192;
const MAX_SETUP_SCRIPT_CHARS: usize = 65_536;

/// How long `workspaceGit.jobCancel` waits for the job to stop and clean up.
const CANCEL_WAIT: Duration = Duration::from_secs(10);
const CANCEL_POLL: Duration = Duration::from_millis(20);

fn to_rpc(error: WorkspaceGitError) -> JsonRpcError {
    let code = if error.code == "INVALID_ARGUMENT" {
        1002
    } else {
        WORKSPACE_GIT_RPC_CODE
    };
    let mut rpc = rpc_err(code, error.message, error.code);
    if let (Some(job_id), Some(data)) = (error.running_job_id, rpc.data.as_mut()) {
        data["jobId"] = json!(job_id);
    }
    rpc
}

fn not_found() -> WorkspaceGitError {
    WorkspaceGitError::new(
        "WORKSPACE_GIT_NOT_FOUND",
        "this host has no worktree for the session",
    )
}

/// What the handlers run git with. Production always clones from GitHub
/// through the proxy rewrite; only a test can point it somewhere else, and
/// only through this constructor, never through an RPC parameter.
#[derive(Default)]
pub(super) struct WorkspaceGitContext {
    git: GitRunner,
    remote_base: Option<String>,
}

impl WorkspaceGitContext {
    /// Clone `<base>/<owner>/<repo>.git` instead of the GitHub URL.
    #[cfg(test)]
    pub(super) fn with_remote_base(base: &str) -> Self {
        Self {
            git: GitRunner::default(),
            remote_base: Some(base.trim_end_matches('/').to_string()),
        }
    }

    #[cfg(test)]
    pub(super) fn with_git(mut self, git: GitRunner) -> Self {
        self.git = git;
        self
    }

    fn clone_url(&self, layout: &Layout, repository: &Repository) -> String {
        match &self.remote_base {
            Some(base) => format!("{base}/{}/{}.git", repository.owner, repository.name),
            None => layout.clone_url(repository),
        }
    }

    /// The per-command git configuration for a network operation: the proxy
    /// rewrite for this repository, and nothing of the host user's own
    /// credential helpers, askpass program, or HTTP proxy.
    pub(super) fn network_config(
        &self,
        proxy_url: &str,
        repository: &Repository,
    ) -> Vec<(String, String)> {
        match &self.remote_base {
            // A substituted remote is not GitHub: there is nothing to rewrite.
            Some(_) => environment::network_config(None, repository),
            None => environment::network_config(Some(proxy_url), repository),
        }
    }
}

// ---- parameters ---------------------------------------------------------------

#[derive(Deserialize)]
struct RepositoryInput {
    owner: String,
    name: String,
}

#[derive(Deserialize)]
struct VariableInput {
    name: String,
    value: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnvironmentInput {
    variables: Vec<VariableInput>,
    #[serde(default)]
    setup_script: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryParams {
    workspaces_root: String,
    repository: RepositoryInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrepareParams {
    workspaces_root: String,
    #[serde(default)]
    git_proxy: Option<Value>,
    installation_id: String,
    session_id: String,
    repository: RepositoryInput,
    base_branch: String,
    #[serde(default)]
    from_session_id: Option<String>,
    #[serde(default)]
    restore_only: bool,
    #[serde(default)]
    rerun_setup: bool,
    #[serde(default)]
    require_setup_success: bool,
    #[serde(default)]
    environment: Option<EnvironmentInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PushParams {
    workspaces_root: String,
    #[serde(default)]
    git_proxy: Option<Value>,
    installation_id: String,
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionParams {
    installation_id: String,
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReclaimParams {
    workspaces_root: String,
    installation_id: String,
    session_id: String,
    #[serde(default)]
    regenerable_dirs: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoveParams {
    installation_id: String,
    session_id: String,
    force: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListParams {
    installation_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JobParams {
    job_id: String,
}

fn parse<T: DeserializeOwned>(params: Value) -> Result<T, JsonRpcError> {
    serde_json::from_value(params).map_err(|error| {
        to_rpc(WorkspaceGitError::invalid(format!(
            "invalid params: {error}"
        )))
    })
}

fn layout(workspaces_root: &str) -> Result<Layout, WorkspaceGitError> {
    Layout::new(Path::new(workspaces_root))
}

fn session_key(installation_id: &str, session_id: &str) -> Result<(), WorkspaceGitError> {
    validate_installation_id(installation_id)?;
    validate_session_id(session_id)
}

/// `gitProxy: { url }`, required by the network methods.
fn proxy_url(git_proxy: Option<&Value>) -> Result<String, WorkspaceGitError> {
    parse_proxy_url(git_proxy.and_then(|proxy| proxy.get("url")))?
        .ok_or_else(|| WorkspaceGitError::invalid("gitProxy.url is required"))
}

/// A prepare request after every name and limit has been checked.
struct PrepareRequest {
    layout: Layout,
    proxy_url: String,
    installation_id: String,
    session_id: String,
    repository: Repository,
    base_branch: String,
    from_session_id: Option<String>,
    restore_only: bool,
    rerun_setup: bool,
    require_setup_success: bool,
    has_environment: bool,
    variables: Vec<Variable>,
    setup_script: Option<String>,
}

impl PrepareRequest {
    fn validate(params: PrepareParams) -> Result<Self, WorkspaceGitError> {
        let layout = layout(&params.workspaces_root)?;
        let proxy_url = proxy_url(params.git_proxy.as_ref())?;
        session_key(&params.installation_id, &params.session_id)?;
        let repository = Repository::parse(&params.repository.owner, &params.repository.name)?;
        validate_branch(&params.base_branch)?;
        if let Some(from) = &params.from_session_id {
            validate_session_id(from)?;
        }
        let has_environment = params.environment.is_some();
        let environment = params.environment.unwrap_or(EnvironmentInput {
            variables: Vec::new(),
            setup_script: None,
        });
        if environment.variables.len() > MAX_VARIABLES {
            return Err(WorkspaceGitError::invalid(
                "environment has too many variables",
            ));
        }
        let mut variables = Vec::with_capacity(environment.variables.len());
        for variable in environment.variables {
            validate_variable_name(&variable.name)?;
            if variable.value.chars().count() > MAX_VARIABLE_VALUE_CHARS
                || variable.value.contains('\0')
            {
                return Err(WorkspaceGitError::invalid(
                    "environment variable value is not allowed",
                ));
            }
            variables.push(Variable {
                name: variable.name,
                value: variable.value,
            });
        }
        if environment
            .setup_script
            .as_ref()
            .is_some_and(|script| script.chars().count() > MAX_SETUP_SCRIPT_CHARS)
        {
            return Err(WorkspaceGitError::invalid("setupScript is too long"));
        }
        Ok(Self {
            layout,
            proxy_url,
            installation_id: params.installation_id,
            session_id: params.session_id,
            repository,
            base_branch: params.base_branch,
            from_session_id: params.from_session_id,
            restore_only: params.restore_only,
            rerun_setup: params.rerun_setup,
            require_setup_success: params.require_setup_success,
            has_environment,
            variables,
            // A blank script is no script.
            setup_script: environment
                .setup_script
                .filter(|script| !script.trim().is_empty()),
        })
    }

    fn strict_restore(&self) -> bool {
        self.restore_only && self.rerun_setup && self.require_setup_success
    }

    fn work_branch(&self) -> String {
        work_branch(&self.installation_id, &self.session_id)
    }

    fn main_path(&self) -> PathBuf {
        self.layout.main_path(&self.repository)
    }

    fn worktree_path(&self) -> PathBuf {
        self.layout.worktree_path(
            &self.repository,
            &short_id(&self.installation_id, &self.session_id),
        )
    }
}

// ---- dispatch -----------------------------------------------------------------

pub(super) async fn handle(
    state: &SharedState,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    handle_with(
        state,
        &Arc::new(WorkspaceGitContext::default()),
        method,
        params,
    )
    .await
}

pub(super) async fn handle_with(
    state: &SharedState,
    context: &Arc<WorkspaceGitContext>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    match method {
        // Where a repository's main checkout lives on this host, and whether
        // it is cloned. No side effects: nothing is created.
        "workspaceGit.repository" => {
            let p: RepositoryParams = parse(params)?;
            let layout = layout(&p.workspaces_root).map_err(to_rpc)?;
            let repository =
                Repository::parse(&p.repository.owner, &p.repository.name).map_err(to_rpc)?;
            let path = layout.main_path(&repository);
            let cloned = is_real_dir(&path) && path.join(".git").is_dir();
            Ok(json!({ "path": path, "cloned": cloned }))
        }
        "workspaceGit.prepare" => {
            let request = PrepareRequest::validate(parse(params)?).map_err(to_rpc)?;
            start_prepare(state, context, request).await.map_err(to_rpc)
        }
        "workspaceGit.push" => {
            let p: PushParams = parse(params)?;
            start_push(state, context, p).await.map_err(to_rpc)
        }
        "workspaceGit.job" => {
            let p: JobParams = parse(params)?;
            let jobs = state.lock().await.workspace_git_jobs.clone();
            let job = lock(&jobs)
                .get(&p.job_id)
                .ok_or_else(|| to_rpc(jobs::job_not_found()))?;
            serde_json::to_value(job).map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))
        }
        "workspaceGit.jobCancel" => {
            let p: JobParams = parse(params)?;
            let jobs = state.lock().await.workspace_git_jobs.clone();
            lock(&jobs).cancel(&p.job_id).map_err(to_rpc)?;
            // The job stops its git process and removes what it created. Wait
            // for that, so the caller can act on the session right away.
            let deadline = tokio::time::Instant::now() + CANCEL_WAIT;
            while tokio::time::Instant::now() < deadline {
                let running = lock(&jobs)
                    .get(&p.job_id)
                    .is_some_and(|job| job.state == JobState::Running);
                if !running {
                    break;
                }
                tokio::time::sleep(CANCEL_POLL).await;
            }
            Ok(json!({ "ok": true }))
        }
        "workspaceGit.status" => {
            let p: SessionParams = parse(params)?;
            status(state, context, &p).await.map_err(to_rpc)
        }
        "workspaceGit.reclaim" => {
            let p: ReclaimParams = parse(params)?;
            start_reclaim(state, context, p).await.map_err(to_rpc)
        }
        "workspaceGit.removeSafely" => {
            let p: SessionParams = parse(params)?;
            remove(
                state,
                context,
                &RemoveParams {
                    installation_id: p.installation_id,
                    session_id: p.session_id,
                    force: false,
                },
            )
            .await
            .map_err(to_rpc)
        }
        "workspaceGit.remove" => {
            let p: RemoveParams = parse(params)?;
            remove(state, context, &p).await.map_err(to_rpc)
        }
        // Private host pipe only. The path is canonicalized by pi-host
        // after it resolves the authorized workspace tool root.
        "workspaceGit.scopeForPath" => {
            let root = params
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| to_rpc(WorkspaceGitError::invalid("path is required")))?;
            let st = state.lock().await;
            let scope = registry::find_by_path(&st.db, Path::new(root))
                .map_err(|error| to_rpc(error.into()))?
                .map(|record| {
                    json!({
                        "installationId": record.installation_id,
                        "sessionId": record.session_id,
                        "repository": record.repository,
                    })
                });
            Ok(json!({ "scope": scope }))
        }
        "workspaceGit.list" => {
            let p: ListParams = parse(params)?;
            validate_installation_id(&p.installation_id).map_err(to_rpc)?;
            let st = state.lock().await;
            let worktrees: Vec<Value> = registry::list_for_installation(&st.db, &p.installation_id)
                .map_err(|error| to_rpc(error.into()))?
                .iter()
                .map(WorktreeRecord::wire)
                .collect();
            Ok(json!({ "worktrees": worktrees }))
        }
        _ => Err(rpc_err(-32601, "method not found", "METHOD_NOT_FOUND")),
    }
}

fn lock(jobs: &SharedJobs) -> std::sync::MutexGuard<'_, jobs::JobTable> {
    jobs.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn exclusive_access(
    state: &AppState,
    installation: &str,
    session: &str,
) -> Result<tokio::sync::OwnedRwLockWriteGuard<()>, WorkspaceGitError> {
    if let Some(job_id) = lock(&state.workspace_git_jobs).running_job(installation, session) {
        return Err(WorkspaceGitError::busy(job_id));
    }
    state
        .workspace_git_locks
        .try_write(installation, session)
        .ok_or_else(|| WorkspaceGitError::new("WORKSPACE_GIT_BUSY", "the worktree is in use"))
}

async fn record_of(
    state: &SharedState,
    installation_id: &str,
    session_id: &str,
) -> Result<Option<WorktreeRecord>, WorkspaceGitError> {
    let st = state.lock().await;
    Ok(registry::get(&st.db, installation_id, session_id)?)
}

async fn restore_for_setup(
    state: &SharedState,
    context: &WorkspaceGitContext,
    request: &PrepareRequest,
    mut record: WorktreeRecord,
) -> Result<WorktreeRecord, WorkspaceGitError> {
    let paths = RegisteredPaths::verify(&request.layout, &record)?;
    if record.recovery.checkout_creation_pending {
        // An earlier restore stopped after `git worktree add` started. Its
        // partial checkout is removed and the restore starts over.
        rollback::roll_back(&context.git, &record).await?;
        record.recovery.checkout_creation_pending = false;
    }
    let _repository = crate::session_worktrees::repo_lock::lock(&paths.common).await;
    let present = match std::fs::symlink_metadata(&paths.checkout) {
        Ok(metadata) if metadata.is_dir() && !record.recovery.checkout_creation_pending => true,
        Ok(_) => return Err(reclaim::interrupted()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(error.into()),
    };
    reclaim::verify_retained_branch(&context.git, &paths, &record).await?;
    if let Some(intent) = &record.recovery.reclaim_intent {
        reclaim::verify_completed_intent(&paths, intent)?;
        record.recovery.reclaim_intent = None;
    }
    if present {
        reclaim::checkout_admin(&context.git, &paths, &record.work_branch).await?;
    }
    if request.has_environment {
        record.variables.clone_from(&request.variables);
        record.setup_script.clone_from(&request.setup_script);
    }
    record.setup_status = if record.setup_script.is_some() {
        SetupStatus::Running
    } else {
        SetupStatus::None
    };
    record.setup_log_tail = None;
    record.recovery.strict_setup_pending = request.require_setup_success;
    record.recovery.checkout_creation_pending = !present;
    registry::persist_recovery(&state.lock().await.db, &record)?;
    if !present {
        // The branch already exists. Git refuses any competing checkout or
        // stale admin entry. Changing the ref or cleaning old files is unsafe.
        reclaim::restore_checkout(&context.git, &paths, &record).await?;
        record.recovery.checkout_creation_pending = false;
        registry::persist_recovery(&state.lock().await.db, &record)?;
    }
    Ok(record)
}

fn setup_failed() -> WorkspaceGitError {
    WorkspaceGitError::new(
        "WORKSPACE_GIT_SETUP_FAILED",
        "workspace setup must succeed before the checkout is ready",
    )
}

async fn run_setup(
    state: &SharedState,
    context: &WorkspaceGitContext,
    jobs: &SharedJobs,
    job_id: &str,
    request: &PrepareRequest,
    mut record: WorktreeRecord,
    cancel: watch::Receiver<bool>,
) -> Outcome {
    let strict = record.recovery.strict_setup_pending;
    if record.setup_status != SetupStatus::Running && !strict {
        return Outcome::Prepared(record.wire());
    }
    if let Some(script) = record.setup_script.as_deref() {
        lock(jobs).set_phase(job_id, JobPhase::RunningSetup);
        let root = Path::new(&record.path);
        let (shell_id, env) = {
            let st = state.lock().await;
            let shell_id = command_shell_catalog(&st)
                .ok()
                .and_then(|catalog| catalog.effective)
                .map(|shell| shell.id);
            let env = environment::for_tool(&st.db, root, Some(&request.proxy_url));
            (shell_id, env)
        };
        let jobs_for_output = jobs.clone();
        let job_id_for_output = job_id.to_owned();
        let on_output = Arc::new(move |tail| {
            lock(&jobs_for_output).set_setup_log_tail(&job_id_for_output, Some(tail));
        });
        let (status, log) = match shell_id {
            Some(shell_id) => {
                setup::run(SetupRun {
                    root,
                    script,
                    shell_id,
                    env,
                    session_id: &request.session_id,
                    short_id: &short_id(&request.installation_id, &request.session_id),
                    cancellation: cancel.clone(),
                    on_output: Some(on_output),
                })
                .await
            }
            None => (
                SetupStatus::Failed,
                "no command shell is available on this host".to_string(),
            ),
        };
        record.setup_status = status;
        record.setup_log_tail = Some(log);
    }
    if strict && record.setup_status != SetupStatus::Failed {
        let verified = async {
            let paths = RegisteredPaths::verify(&request.layout, &record)?;
            let _repository = crate::session_worktrees::repo_lock::lock(&paths.common).await;
            reclaim::verify_retained_branch(&context.git, &paths, &record).await?;
            reclaim::checkout_admin(&context.git, &paths, &record.work_branch).await?;
            Ok::<_, WorkspaceGitError>(())
        }
        .await;
        if let Err(error) = verified {
            record.setup_status = SetupStatus::Failed;
            record.setup_log_tail = Some(error.message);
        }
    }
    if *cancel.borrow() {
        if strict || request.rerun_setup {
            record.setup_status = SetupStatus::Failed;
            if record
                .setup_log_tail
                .as_ref()
                .is_none_or(|log| log.trim().is_empty())
            {
                record.setup_log_tail = Some("Setup was cancelled.".into());
            }
            let save = if strict {
                registry::persist_recovery
            } else {
                registry::insert
            };
            if let Err(error) = save(&state.lock().await.db, &record) {
                return Outcome::Failed(error.into());
            }
        }
        return Outcome::Cancelled;
    }
    let failed = strict && record.setup_status == SetupStatus::Failed;
    if strict && !failed {
        record.recovery = Default::default();
    }
    let save = if strict {
        registry::persist_recovery
    } else {
        registry::insert
    };
    if let Err(error) = save(&state.lock().await.db, &record) {
        return Outcome::Failed(error.into());
    }
    if failed {
        Outcome::SetupFailed {
            worktree: record.wire(),
            error: setup_failed(),
        }
    } else {
        Outcome::Prepared(record.wire())
    }
}

/// Undo a prepare cancelled during its setup script: the worktree, its
/// branch, and the record. The record is marked unfinished first and removed
/// last, so a removal that fails or is interrupted is finished by the next
/// prepare or remove instead of leaving a branch no record owns.
async fn discard(
    state: &SharedState,
    context: &WorkspaceGitContext,
    request: &PrepareRequest,
    mut record: WorktreeRecord,
) {
    record.recovery.checkout_creation_pending = true;
    record.recovery.branch_creation_pending = true;
    if let Err(error) = registry::persist_recovery(&state.lock().await.db, &record) {
        tracing::warn!(%error, "could not mark a cancelled worktree for removal");
        return;
    }
    if let Err(error) = worktree::remove(
        &context.git,
        &request.main_path(),
        &request.worktree_path(),
        &request.work_branch(),
    )
    .await
    {
        tracing::warn!(%error, "could not remove a cancelled worktree");
        return;
    }
    let st = state.lock().await;
    if let Err(error) = registry::remove(&st.db, &request.installation_id, &request.session_id) {
        tracing::warn!(%error, "could not remove a cancelled worktree record");
    }
}

// ---- push ---------------------------------------------------------------------

async fn start_push(
    state: &SharedState,
    context: &Arc<WorkspaceGitContext>,
    params: PushParams,
) -> Result<Value, WorkspaceGitError> {
    layout(&params.workspaces_root)?;
    let proxy_url = proxy_url(params.git_proxy.as_ref())?;
    session_key(&params.installation_id, &params.session_id)?;
    let (jobs, job_id, cancel, record, access) = {
        let st = state.lock().await;
        let access = exclusive_access(&st, &params.installation_id, &params.session_id)?;
        let jobs = st.workspace_git_jobs.clone();
        let mut table = lock(&jobs);
        let record = registry::get(&st.db, &params.installation_id, &params.session_id)?
            .filter(|record| {
                !record.recovery.blocks_access() && is_real_dir(Path::new(&record.path))
            })
            .ok_or_else(not_found)?;
        let (job_id, cancel) =
            table.start(JobKind::Push, &params.installation_id, &params.session_id)?;
        drop(table);
        (jobs, job_id, cancel, record, access)
    };
    tokio::spawn(run_push(
        context.clone(),
        jobs,
        job_id.clone(),
        record,
        proxy_url,
        cancel,
        access,
    ));
    Ok(json!({ "jobId": job_id }))
}

async fn run_push(
    context: Arc<WorkspaceGitContext>,
    jobs: SharedJobs,
    job_id: String,
    record: WorktreeRecord,
    proxy_url: String,
    mut cancel: watch::Receiver<bool>,
    access: tokio::sync::OwnedRwLockWriteGuard<()>,
) {
    lock(&jobs).set_phase(&job_id, JobPhase::Pushing);
    let outcome = match record.repository.validated() {
        Err(error) => Outcome::Failed(error),
        Ok(repository) => {
            let config = context.network_config(&proxy_url, &repository);
            let config: Vec<(&str, &str)> = config
                .iter()
                .map(|(key, value)| (key.as_str(), value.as_str()))
                .collect();
            let on_progress = |progress: JobProgress| {
                lock(&jobs).set_progress(&job_id, Some(progress));
            };
            let network = NetworkContext {
                git: &context.git,
                config: &config,
                on_progress: Some(&on_progress),
            };
            let pushed = tokio::select! {
                biased;
                _ = jobs::cancelled(&mut cancel) => None,
                result = worktree::push(&network, Path::new(&record.path), &record.work_branch) => Some(result),
            };
            match pushed {
                None => Outcome::Cancelled,
                Some(Err(error)) => Outcome::Failed(error),
                Some(Ok(remote_head)) => Outcome::Pushed(Pushed {
                    branch: record.work_branch.clone(),
                    remote_head,
                }),
            }
        }
    };
    let mut table = lock(&jobs);
    drop(access);
    table.finish(&job_id, outcome);
}

// ---- status and remove ----------------------------------------------------------

async fn status(
    state: &SharedState,
    context: &WorkspaceGitContext,
    params: &SessionParams,
) -> Result<Value, WorkspaceGitError> {
    session_key(&params.installation_id, &params.session_id)?;
    let (record, _access) = {
        let st = state.lock().await;
        let access = st
            .workspace_git_locks
            .try_read(&params.installation_id, &params.session_id);
        if access.is_none()
            && lock(&st.workspace_git_jobs)
                .running_job(&params.installation_id, &params.session_id)
                .is_none()
        {
            return Err(WorkspaceGitError::new(
                "WORKSPACE_GIT_BUSY",
                "the worktree is in use",
            ));
        }
        let record = registry::get(&st.db, &params.installation_id, &params.session_id)?
            .filter(|record| !record.recovery.branch_creation_pending)
            .ok_or_else(not_found)?;
        (record, access)
    };
    let path = Path::new(&record.path);
    let main = Path::new(&record.main_path);
    let counts = if record.recovery.reclaim_intent.is_none()
        && !record.recovery.checkout_creation_pending
        && is_real_dir(path)
    {
        worktree::status(&context.git, path, &record.work_branch).await?
    } else {
        worktree::branch_status(&context.git, main, &record.work_branch, 0).await?
    };
    let ahead_of_base = worktree::commits_ahead_of_base(
        &context.git,
        main,
        &record.work_branch,
        &record.base_branch,
        &record.base_commit,
    )
    .await?;
    Ok(json!({
        "worktree": record.wire(),
        "aheadOfBase": ahead_of_base,
        "ahead": counts.ahead,
        "behind": counts.behind,
        "uncommittedFiles": counts.uncommitted_files,
        "unpushedCommits": counts.unpushed_commits,
        "pushedOnce": counts.pushed_once,
    }))
}

/// Remove a worktree and its local work branch. Without `force`, work that
/// would be lost (uncommitted files, commits no remote branch has) makes it
/// answer `removed: false` with the counts instead.
async fn remove(
    state: &SharedState,
    context: &WorkspaceGitContext,
    params: &RemoveParams,
) -> Result<Value, WorkspaceGitError> {
    session_key(&params.installation_id, &params.session_id)?;
    let (mut record, _access) = {
        let st = state.lock().await;
        let access = exclusive_access(&st, &params.installation_id, &params.session_id)?;
        let record = registry::get(&st.db, &params.installation_id, &params.session_id)?
            .ok_or_else(not_found)?;
        // An interrupted reclaim's checkout may sit in its quarantine, where
        // its work cannot be counted. Only a forced remove discards it.
        if record.recovery.reclaim_intent.is_some() && !params.force {
            return Err(reclaim::interrupted());
        }
        (record, access)
    };
    if record.recovery.checkout_creation_pending {
        match prepare::roll_back_unfinished(state, context, record.clone()).await {
            Ok(None) => {
                return Ok(json!({ "removed": true, "uncommittedFiles": 0, "unpushedCommits": 0 }))
            }
            Ok(Some(remaining)) => record = remaining,
            // Kept because its branch gained commits: the checks below
            // count them, and only `force` discards them.
            Err(error) => tracing::info!(%error, "removing an unfinished worktree with checks"),
        }
    }
    let (removed, uncommitted_files, unpushed_commits) = worktree::remove_checked(
        &context.git,
        Path::new(&record.main_path),
        Path::new(&record.path),
        &record.work_branch,
        params.force,
    )
    .await?;
    if removed {
        if let Some(intent) = &record.recovery.reclaim_intent {
            // Forced (checked above): the quarantined checkout goes too. Only
            // the directory reclaim created is removed, never a link.
            let quarantine = reclaim::quarantine_path(Path::new(&record.path), intent)?;
            if is_real_dir(&quarantine) {
                std::fs::remove_dir_all(&quarantine)?;
            }
        }
        let st = state.lock().await;
        registry::remove(&st.db, &params.installation_id, &params.session_id)?;
    }
    Ok(json!({
        "removed": removed, "uncommittedFiles": uncommitted_files, "unpushedCommits": unpushed_commits,
    }))
}

async fn start_reclaim(
    state: &SharedState,
    context: &Arc<WorkspaceGitContext>,
    params: ReclaimParams,
) -> Result<Value, WorkspaceGitError> {
    session_key(&params.installation_id, &params.session_id)?;
    let layout = layout(&params.workspaces_root)?;
    let dirs = reclaim::validate_regenerable_dirs(&params.regenerable_dirs)?;
    let (record, access) = {
        let st = state.lock().await;
        let Ok(access) = exclusive_access(&st, &params.installation_id, &params.session_id) else {
            return Ok(reclaim::refused(Refusal::Busy));
        };
        let record = registry::get(&st.db, &params.installation_id, &params.session_id)?
            .filter(|record| !record.recovery.branch_creation_pending)
            .ok_or_else(not_found)?;
        (record, access)
    };
    // A disconnected or timed-out client must not release the exclusive
    // guard while a filesystem operation from this request is still running.
    let state = state.clone();
    let context = context.clone();
    tokio::spawn(async move {
        let _access = access;
        reclaim::execute(&context.git, &layout, record, dirs, |record| {
            let state = state.clone();
            async move {
                registry::persist_recovery(&state.lock().await.db, &record)?;
                Ok(())
            }
        })
        .await
    })
    .await
    .map_err(|_| reclaim::interrupted())?
}
