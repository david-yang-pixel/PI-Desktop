//! `workspaceGit.push`: push a session's work branch as a job.

use super::*;
use crate::workspace_git::push::{self, PushPlan};

pub(super) async fn start_push(
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
        PushRequest {
            proxy_url,
            force_with_lease: params.force_with_lease,
        },
        cancel,
        access,
    ));
    Ok(json!({ "jobId": job_id }))
}

/// What the caller asked of one push.
struct PushRequest {
    proxy_url: String,
    force_with_lease: bool,
}

async fn run_push(
    context: Arc<WorkspaceGitContext>,
    jobs: SharedJobs,
    job_id: String,
    record: WorktreeRecord,
    request: PushRequest,
    mut cancel: watch::Receiver<bool>,
    access: tokio::sync::OwnedRwLockWriteGuard<()>,
) {
    lock(&jobs).set_phase(&job_id, JobPhase::Pushing);
    let path = Path::new(&record.path);
    // The exclusive guard covers only resolving what to send. The transfer
    // runs without it, so the session's tools keep working; the running job
    // still keeps prepare, remove, and reclaim of this session away.
    let planned = push::plan(&context.git, path, &record.work_branch).await;
    drop(access);
    let outcome = match (record.repository.validated(), planned) {
        (Err(error), _) | (_, Err(error)) => Outcome::Failed(error),
        (Ok(repository), Ok(plan)) => {
            match transfer(
                &context,
                &jobs,
                &job_id,
                &record,
                &repository,
                &request,
                &plan,
                &mut cancel,
            )
            .await
            {
                None => Outcome::Cancelled,
                Some(Err(error)) => Outcome::Failed(error),
                Some(Ok(remote_head)) => Outcome::Pushed(Pushed {
                    branch: record.work_branch.clone(),
                    remote_head,
                }),
            }
        }
    };
    lock(&jobs).finish(&job_id, outcome);
}

/// The network step; `None` when the job was cancelled.
#[allow(clippy::too_many_arguments)]
async fn transfer(
    context: &WorkspaceGitContext,
    jobs: &SharedJobs,
    job_id: &str,
    record: &WorktreeRecord,
    repository: &Repository,
    request: &PushRequest,
    plan: &PushPlan,
    cancel: &mut watch::Receiver<bool>,
) -> Option<Result<String, WorkspaceGitError>> {
    let config = context.network_config(&request.proxy_url, repository);
    let config: Vec<(&str, &str)> = config
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect();
    let on_progress = |progress: JobProgress| {
        lock(jobs).set_progress(job_id, Some(progress));
    };
    let network = NetworkContext {
        git: &context.git,
        config: &config,
        on_progress: Some(&on_progress),
    };
    tokio::select! {
        biased;
        _ = jobs::cancelled(cancel) => None,
        result = push::push(&network, Path::new(&record.path), &record.work_branch, plan, request.force_with_lease) => Some(result),
    }
}
