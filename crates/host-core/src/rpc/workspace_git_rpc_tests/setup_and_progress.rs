use super::*;

/// Branch names follow git's rules, not an allowlist: a name GitHub lists must
/// survive every layer down to git, as an operand and inside a full ref name.
#[tokio::test]
async fn a_worktree_is_prepared_from_base_branches_with_unusual_names() {
    let f = Fixture::new();
    for (session, branch) in [
        ("session-hash", "fix/#123"),
        ("session-equals", "release=1.0"),
        ("session-unicode", "功能/登录"),
    ] {
        let head = f.remote.create_branch(branch, "develop");
        let worktree = f.prepare(session, branch).await;
        assert_eq!(worktree["baseBranch"], branch);
        assert_eq!(worktree["baseCommit"], head, "{branch}");
        let path = f.worktree_path(session);
        assert_eq!(rev_parse(&path, "HEAD"), head, "{branch}");
        assert!(path.join("develop.txt").is_file());
        // The name never became part of a path: the directory is the short id.
        assert_eq!(
            path.file_name().unwrap().to_str().unwrap(),
            short_id(INSTALLATION, session)
        );
        let status = f
            .call("workspaceGit.status", f.session(session))
            .await
            .unwrap();
        assert_eq!(status["worktree"]["baseBranch"], branch);
    }
    // An owner with an underscore is a valid coordinate (it is simply absent here).
    let mut params = f.prepare_params("session-emu", "main");
    params["repository"] = json!({ "owner": "mona_acme", "name": "repo" });
    let job_id = f.start_prepare(params).await;
    let (job, _phases) = f.wait(&job_id).await;
    assert_eq!(
        job["error"]["code"], "WORKSPACE_GIT_REPOSITORY_NOT_FOUND",
        "{job}"
    );
}

#[tokio::test]
async fn rerun_setup_reruns_script_in_place_and_rejects_when_busy() {
    let f = Fixture::new();
    let mut params = f.prepare_params("session-rerun", "main");
    params["environment"] = json!({
        "variables": [{ "name": "SETUP_MODE", "value": "fail" }],
        "setupScript": "echo first-attempt; exit 1",
    });
    let first_id = f.start_prepare(params).await;
    let (first_job, _) = f.wait(&first_id).await;
    assert_eq!(first_job["state"], "succeeded", "{first_job}");
    assert_eq!(first_job["worktree"]["setup"]["status"], "failed");
    let worktree_path = PathBuf::from(first_job["worktree"]["path"].as_str().unwrap());
    let work_branch = first_job["worktree"]["workBranch"]
        .as_str()
        .unwrap()
        .to_string();

    // Place an untracked marker in the worktree to prove rerunSetup does not delete/recreate it.
    let marker = worktree_path.join("preserve-me.txt");
    std::fs::write(&marker, "kept").unwrap();

    // Rerun with a gated script so we can also observe WORKSPACE_GIT_BUSY and live setupLogTail.
    let gate = f.dir.path().join("setup.gate");
    let mut rerun_params = f.prepare_params("session-rerun", "main");
    rerun_params["rerunSetup"] = json!(true);
    rerun_params["environment"] = json!({
        "variables": [{ "name": "SETUP_MODE", "value": "ok" }],
        "setupScript": format!(
            "echo rerun-started-$SETUP_MODE; while [ ! -f '{}' ]; do sleep 0.02; done; echo rerun-done",
            gate.display()
        ),
    });
    let rerun_id = f.start_prepare(rerun_params.clone()).await;

    // Poll until live setupLogTail shows up in workspaceGit.job.
    let mut saw_live_tail = false;
    for _ in 0..500 {
        let job = f
            .call("workspaceGit.job", json!({ "jobId": rerun_id }))
            .await
            .unwrap();
        if job["phase"] == "runningSetup"
            && job["setupLogTail"]
                .as_str()
                .is_some_and(|tail| tail.contains("rerun-started-ok"))
        {
            saw_live_tail = true;
            break;
        }
        assert_eq!(job["state"], "running", "job ended too early: {job}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(
        saw_live_tail,
        "expected live setupLogTail while setup is running"
    );

    // A concurrent prepare while setup is running is rejected with WORKSPACE_GIT_BUSY.
    let busy_err = f
        .call("workspaceGit.prepare", rerun_params)
        .await
        .unwrap_err();
    assert_eq!(code(&busy_err), "WORKSPACE_GIT_BUSY");

    // Release the gate and confirm the rerun succeeds in place.
    std::fs::write(&gate, "go").unwrap();
    let (rerun_job, _) = f.wait(&rerun_id).await;
    assert_eq!(rerun_job["state"], "succeeded", "{rerun_job}");
    assert_eq!(
        rerun_job["worktree"]["path"],
        worktree_path.to_str().unwrap()
    );
    assert_eq!(rerun_job["worktree"]["workBranch"], work_branch);
    assert_eq!(rerun_job["worktree"]["setup"]["status"], "ok");
    assert!(
        rerun_job["worktree"]["setup"]["logTail"]
            .as_str()
            .unwrap_or("")
            .contains("rerun-done"),
        "{rerun_job}"
    );
    assert_eq!(std::fs::read_to_string(&marker).unwrap(), "kept");
}

#[cfg(unix)]
#[tokio::test]
async fn prepare_and_push_report_git_progress_on_running_jobs() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::with_git(|base| {
        let gate = base.join("progress.gate");
        let script = base.join("progress-git");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\n\
                 case \" $* \" in\n\
                   *\" clone \"*)\n\
                     printf 'Receiving objects:  42%% (10/24)\\r' >&2\n\
                     while [ ! -f '{gate}' ]; do sleep 0.02; done\n\
                     ;;\n\
                   *\" push \"*)\n\
                     printf 'Writing objects:  75%% (3/4)\\r' >&2\n\
                     while [ ! -f '{gate}' ]; do sleep 0.02; done\n\
                     ;;\n\
                 esac\n\
                 exec git \"$@\"\n",
                gate = gate.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        GitRunner::with_program(script)
    });
    let gate = f.root.parent().unwrap().join("progress.gate");

    // 1. Clone progress during prepare.
    let prepare_id = f
        .start_prepare(f.prepare_params("session-progress", "main"))
        .await;
    let mut saw_clone_progress = false;
    for _ in 0..500 {
        let job = f
            .call("workspaceGit.job", json!({ "jobId": prepare_id }))
            .await
            .unwrap();
        if job["progress"]["percent"] == 42 && job["progress"]["detail"] == "Receiving objects" {
            saw_clone_progress = true;
            break;
        }
        assert_eq!(job["state"], "running", "prepare ended early: {job}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(saw_clone_progress, "expected clone progress on prepare job");
    std::fs::write(&gate, "go").unwrap();
    let (prepared, _) = f.wait(&prepare_id).await;
    assert_eq!(prepared["state"], "succeeded", "{prepared}");
    assert!(prepared.get("progress").is_none());

    // 2. Push progress after making a commit in the worktree.
    std::fs::remove_file(&gate).unwrap();
    let worktree_path = PathBuf::from(prepared["worktree"]["path"].as_str().unwrap());
    commit_file(&worktree_path, "progress.txt", "hello");
    let push_started = f
        .call(
            "workspaceGit.push",
            json!({
                "gitProxy": f.proxy(),
                "installationId": INSTALLATION,
                "sessionId": "session-progress",
            }),
        )
        .await
        .unwrap();
    let push_id = push_started["jobId"].as_str().unwrap().to_string();
    let mut saw_push_progress = false;
    for _ in 0..500 {
        let job = f
            .call("workspaceGit.job", json!({ "jobId": push_id }))
            .await
            .unwrap();
        if job["progress"]["percent"] == 75 && job["progress"]["detail"] == "Writing objects" {
            saw_push_progress = true;
            break;
        }
        assert_eq!(job["state"], "running", "push ended early: {job}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(saw_push_progress, "expected push progress on push job");
    std::fs::write(&gate, "go").unwrap();
    let (pushed, _) = f.wait(&push_id).await;
    assert_eq!(pushed["state"], "succeeded", "{pushed}");
    assert!(pushed.get("progress").is_none());
}

/// The proxy address carries a handle that is not for the desktop or the
/// registry: setup output that prints it is stored and reported with the
/// GitHub URL it stands for, live and at the end.
#[cfg(unix)]
#[tokio::test]
async fn setup_output_never_carries_the_proxy_handle() {
    let f = Fixture::new();
    let handle = "ab".repeat(32);
    let gate = f.dir.path().join("setup-redact.gate");
    let mut params = f.prepare_params("session-redact", "main");
    params["environment"] = json!({
        "variables": [],
        "setupScript": format!(
            "echo \"key=$GIT_CONFIG_KEY_0\"; while [ ! -f '{}' ]; do sleep 0.02; done; echo \"again=$GIT_CONFIG_KEY_0\"",
            gate.display()
        ),
    });
    let job_id = f.start_prepare(params).await;
    let mut live = None;
    for _ in 0..1000 {
        let job = f
            .call("workspaceGit.job", json!({ "jobId": job_id }))
            .await
            .unwrap();
        if let Some(tail) = job["setupLogTail"]
            .as_str()
            .filter(|tail| tail.contains("key="))
        {
            live = Some(tail.to_string());
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let live = live.expect("live setup output");
    assert!(!live.contains(&handle), "{live}");
    assert!(
        live.contains("key=url.https://github.com/octo/repo.git.insteadOf"),
        "{live}"
    );
    std::fs::write(&gate, "").unwrap();
    let (job, _phases) = f.wait(&job_id).await;
    assert_eq!(job["state"], "succeeded", "{job}");
    let tail = job["worktree"]["setup"]["logTail"].as_str().unwrap();
    assert!(tail.contains("again=url.https://github.com/"), "{tail}");
    // Not in the job, the listing, or the registry row on disk.
    let listed = f
        .call(
            "workspaceGit.list",
            json!({ "installationId": INSTALLATION }),
        )
        .await
        .unwrap();
    for text in [job.to_string(), listed.to_string()] {
        assert!(!text.contains(&handle), "{text}");
        assert!(!text.contains("127.0.0.1:4321"), "{text}");
    }
    let stored = {
        let state = f.state.lock().await;
        crate::workspace_git::registry::get(&state.db, INSTALLATION, "session-redact")
            .unwrap()
            .unwrap()
    };
    assert!(!stored.setup_log_tail.unwrap().contains(&handle));
}
