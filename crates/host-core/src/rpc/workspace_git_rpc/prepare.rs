use super::*;

pub(super) async fn start_prepare(
    state: &SharedState,
    context: &Arc<WorkspaceGitContext>,
    request: PrepareRequest,
) -> Result<Value, WorkspaceGitError> {
    let (jobs, job_id, cancel, access) = {
        let st = state.lock().await;
        let access = exclusive_access(&st, &request.installation_id, &request.session_id)?;
        let jobs = st.workspace_git_jobs.clone();
        let mut table = lock(&jobs);
        // An unfinished creation is not a registration yet: the job rolls it
        // back first and then prepares the session afresh.
        let registered = registry::get(&st.db, &request.installation_id, &request.session_id)?
            .filter(|record| !record.recovery.branch_creation_pending);
        if let Some(record) = registered {
            if record.repository != request.repository {
                return Err(WorkspaceGitError::invalid(
                    "this session is already bound to another repository",
                ));
            }
            if record
                .recovery
                .reclaim_intent
                .as_ref()
                .is_some_and(|intent| !intent.quarantined)
            {
                return Err(reclaim::interrupted());
            }
            let retry_setup = record.recovery.reclaimed_at.is_none()
                && record.recovery.reclaimed_commit.is_none()
                && request.rerun_setup
                && request.require_setup_success;
            if record.recovery.blocks_access() && !request.strict_restore() && !retry_setup {
                return Err(WorkspaceGitError::failed(
                    "the workspace requires strict setup before it can be used",
                ));
            }
            if !request.rerun_setup && is_real_dir(Path::new(&record.path)) {
                let outcome = if request.require_setup_success
                    && record.setup_status == SetupStatus::Failed
                {
                    Outcome::SetupFailed {
                        worktree: record.wire(),
                        error: setup_failed(),
                    }
                } else {
                    Outcome::Prepared(record.wire())
                };
                let job_id = table.completed(
                    JobKind::Prepare,
                    &request.installation_id,
                    &request.session_id,
                    outcome,
                );
                return Ok(json!({ "jobId": job_id }));
            }
        } else if request.restore_only {
            return Err(not_found());
        }
        let (job_id, cancel) = table.start(
            JobKind::Prepare,
            &request.installation_id,
            &request.session_id,
        )?;
        drop(table);
        (jobs, job_id, cancel, access)
    };
    tokio::spawn(run_prepare(
        state.clone(),
        context.clone(),
        jobs,
        job_id.clone(),
        request,
        cancel,
        access,
    ));
    Ok(json!({ "jobId": job_id }))
}

async fn run_prepare(
    state: SharedState,
    context: Arc<WorkspaceGitContext>,
    jobs: SharedJobs,
    job_id: String,
    request: PrepareRequest,
    mut cancel: watch::Receiver<bool>,
    access: tokio::sync::OwnedRwLockWriteGuard<()>,
) {
    // A prepare of this session that stopped before its checkout was complete
    // (a host-core restart, or a rollback that failed) is undone first.
    if let Err(error) = discard_unfinished(&state, &context, &request).await {
        let mut table = lock(&jobs);
        drop(access);
        table.finish(&job_id, Outcome::Failed(error));
        return;
    }
    // Dropping the git future kills its process (`kill_on_drop`) and removes
    // a half-written clone directory.
    let may_discard = match record_of(&state, &request.installation_id, &request.session_id).await {
        Ok(None) => matches!(
            std::fs::symlink_metadata(request.worktree_path()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound
        ),
        _ => false,
    };
    let created = tokio::select! {
        biased;
        _ = jobs::cancelled(&mut cancel) => None,
        result = create_worktree(&state, &context, &jobs, &job_id, &request) => Some(result),
    };
    let outcome = match created {
        None => Outcome::Cancelled,
        Some(Err(error)) => Outcome::Failed(error),
        Some(Ok(record)) => {
            run_setup(&state, &context, &jobs, &job_id, &request, record, cancel).await
        }
    };
    let stopped = outcome == Outcome::Cancelled || matches!(outcome, Outcome::Failed(_));
    let record = if stopped {
        record_of(&state, &request.installation_id, &request.session_id).await
    } else {
        Ok(None)
    };
    match record {
        // A cancelled or failed prepare leaves no worktree, record, or branch
        // behind; the main checkout stays. Only this job can have registered
        // an unfinished creation: an earlier one was rolled back above.
        Ok(Some(record)) if record.recovery.branch_creation_pending => {
            if let Err(error) = roll_back_unfinished(&state, &context, record).await {
                tracing::warn!(%error, "could not roll back an unfinished worktree");
            }
        }
        // Cancelled while the setup script ran.
        Ok(Some(record)) if may_discard && outcome == Outcome::Cancelled => {
            discard(&state, &context, &request, record).await;
        }
        // Never leave an existing worktree stuck in `setup_status = Running`.
        Ok(Some(mut record)) if !may_discard && record.setup_status == SetupStatus::Running => {
            let note = match &outcome {
                Outcome::Cancelled => "Setup was cancelled.".to_string(),
                Outcome::Failed(error) => error.message.clone(),
                _ => "Setup did not complete.".to_string(),
            };
            record.setup_status = SetupStatus::Failed;
            record.setup_log_tail = Some(note);
            let save = if record.recovery.blocks_access() {
                registry::persist_recovery
            } else {
                registry::insert
            };
            if let Err(error) = save(&state.lock().await.db, &record) {
                tracing::warn!(%error, "could not recover setup status after failed rerun");
            }
        }
        _ => {}
    }
    let mut table = lock(&jobs);
    drop(access);
    table.finish(&job_id, outcome);
}

/// Ensure the main checkout, create the worktree, and register it.
async fn create_worktree(
    state: &SharedState,
    context: &WorkspaceGitContext,
    jobs: &SharedJobs,
    job_id: &str,
    request: &PrepareRequest,
) -> Result<WorktreeRecord, WorkspaceGitError> {
    let main_path = request.main_path();
    let worktree_path = request.worktree_path();
    let work_branch = request.work_branch();
    request.layout.ensure_private_directories()?;
    if let Some(record) = record_of(state, &request.installation_id, &request.session_id).await? {
        lock(jobs).set_phase(job_id, JobPhase::CreatingWorktree);
        if request.rerun_setup {
            return restore_for_setup(state, context, request, record).await;
        }
        worktree::restore(
            &context.git,
            Path::new(&record.main_path),
            Path::new(&record.path),
            &record.work_branch,
        )
        .await?;
        return Ok(record);
    }
    if request.restore_only {
        return Err(not_found());
    }

    let config = context.network_config(&request.proxy_url, &request.repository);
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
    let on_phase = |phase: Phase| {
        lock(jobs).set_phase(
            job_id,
            match phase {
                Phase::Cloning => JobPhase::Cloning,
                Phase::Fetching => JobPhase::Fetching,
            },
        );
    };
    let remote_url = context.clone_url(&request.layout, &request.repository);
    repository::ensure(&network, &remote_url, &main_path, &on_phase).await?;

    // A forked session starts at its parent's work branch as it is on this
    // host, including commits the parent never pushed.
    let parent_branch = match &request.from_session_id {
        Some(from) => {
            let parent = record_of(state, &request.installation_id, from)
                .await?
                .filter(|parent| !parent.recovery.branch_creation_pending);
            match parent {
                Some(parent) if parent.repository == request.repository => Some(parent.work_branch),
                _ => return Err(not_found()),
            }
        }
        None => None,
    };
    let start = match &parent_branch {
        Some(branch) => StartPoint::LocalBranch(branch),
        None => StartPoint::RemoteBranch(&request.base_branch),
    };

    lock(jobs).set_phase(job_id, JobPhase::CreatingWorktree);
    let creation = worktree::begin_create(
        &context.git,
        &main_path,
        &worktree_path,
        &work_branch,
        start,
    )
    .await?;
    let mut record = new_record(request, &main_path, &worktree_path, &creation.base_commit)?;
    // Registered before git creates the branch or the checkout, so anything
    // that stops this prepare from here on leaves a registration owning what
    // was created, which the next prepare or remove rolls back.
    record.recovery.checkout_creation_pending = true;
    record.recovery.branch_creation_pending = true;
    registry::persist_recovery(&state.lock().await.db, &record)?;
    creation.add(&context.git, &main_path).await?;
    record.recovery.checkout_creation_pending = false;
    record.recovery.branch_creation_pending = false;
    registry::insert(&state.lock().await.db, &record)?;
    Ok(record)
}

fn new_record(
    request: &PrepareRequest,
    main_path: &Path,
    worktree_path: &Path,
    base_commit: &str,
) -> Result<WorktreeRecord, WorkspaceGitError> {
    // Tool roots are canonicalized before they are matched against records.
    // The checkout does not exist yet; its parent does.
    let path = match (worktree_path.parent(), worktree_path.file_name()) {
        (Some(parent), Some(name)) => crate::workspace::simple_canonicalize(parent)?.join(name),
        _ => return Err(WorkspaceGitError::invalid("invalid worktree path")),
    };
    let text = |path: &Path| {
        path.to_str()
            .map(str::to_string)
            .ok_or_else(|| WorkspaceGitError::invalid("path is not valid UTF-8"))
    };
    let record = WorktreeRecord {
        installation_id: request.installation_id.clone(),
        session_id: request.session_id.clone(),
        repository: request.repository.clone(),
        base_branch: request.base_branch.clone(),
        work_branch: request.work_branch(),
        path: text(&path)?,
        main_path: text(main_path)?,
        base_commit: base_commit.to_string(),
        created_at: crate::db::ms_to_ts(crate::db::now_ms()),
        variables: request.variables.clone(),
        setup_script: request.setup_script.clone(),
        setup_status: if request.setup_script.is_some() {
            SetupStatus::Running
        } else {
            SetupStatus::None
        },
        setup_log_tail: None,
        last_pushed_commit: None,
        recovery: registry::Recovery {
            strict_setup_pending: request.require_setup_success && request.setup_script.is_some(),
            ..Default::default()
        },
    };
    Ok(record)
}

/// Roll back an unfinished creation and update its registration: a new
/// session's is removed; a restored checkout's goes back to "no checkout".
/// Returns the registration that remains, if any.
pub(super) async fn roll_back_unfinished(
    state: &SharedState,
    context: &WorkspaceGitContext,
    mut record: WorktreeRecord,
) -> Result<Option<WorktreeRecord>, WorkspaceGitError> {
    rollback::roll_back(&context.git, &record).await?;
    let st = state.lock().await;
    if record.recovery.branch_creation_pending {
        registry::remove(&st.db, &record.installation_id, &record.session_id)?;
        return Ok(None);
    }
    record.recovery.checkout_creation_pending = false;
    registry::persist_recovery(&st.db, &record)?;
    Ok(Some(record))
}

async fn discard_unfinished(
    state: &SharedState,
    context: &WorkspaceGitContext,
    request: &PrepareRequest,
) -> Result<(), WorkspaceGitError> {
    match record_of(state, &request.installation_id, &request.session_id).await? {
        Some(record) if record.recovery.branch_creation_pending => {
            roll_back_unfinished(state, context, record).await.map(drop)
        }
        _ => Ok(()),
    }
}
