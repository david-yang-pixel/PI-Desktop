use std::fs;

use super::*;
use crate::workspace_git::registry::{self, ReclaimIntent, SetupStatus};

async fn reclaim(f: &Fixture, session: &str) -> Value {
    f.call("workspaceGit.reclaim", f.session(session))
        .await
        .unwrap()
}

fn strict(f: &Fixture, session: &str) -> Value {
    let mut params = f.prepare_params(session, "main");
    params["restoreOnly"] = json!(true);
    params["rerunSetup"] = json!(true);
    params["requireSetupSuccess"] = json!(true);
    params
}

fn publish(path: &Path) {
    git_cmd(path, &["push", "origin", "HEAD"]);
}

#[cfg(unix)]
#[tokio::test]
async fn reclaim_and_strict_wake_preserve_the_branch_and_retry_setup_in_place() {
    let f = Fixture::new();
    let session = "strict-wake";
    f.prepare(session, "main").await;
    let path = f.worktree_path(session);
    commit_file(&path, ".gitignore", "node_modules/\ndist/\nfrontend/out/\n");
    fs::create_dir(path.join(".pi")).unwrap();
    let commit = commit_file(
        &path,
        ".pi/workspace.json",
        r#"{"reclaim":{"regenerableDirs":["dist"]}}"#,
    );
    publish(&path);
    for dir in ["node_modules", "dist", "frontend/out"] {
        fs::create_dir_all(path.join(dir)).unwrap();
        fs::write(path.join(dir).join("generated"), "generated").unwrap();
    }
    let mut params = f.session(session);
    params["regenerableDirs"] = json!(["frontend/out"]);
    let result = f.call("workspaceGit.reclaim", params).await.unwrap();
    assert_eq!(result["reclaimed"], true, "{result}");
    assert_eq!(result["commit"], commit);
    assert!(result["reclaimedAt"].as_str().is_some());
    assert!(!path.exists());
    let branch = work_branch(INSTALLATION, session);
    assert_eq!(
        rev_parse(&f.main_path(), &format!("refs/heads/{branch}")),
        commit
    );
    assert_eq!(worktree_count(&f.main_path()), 1);
    let repeated = reclaim(&f, session).await;
    assert_eq!(repeated["alreadyReclaimed"], true);
    assert_eq!(repeated["reclaimedAt"], result["reclaimedAt"]);

    let mut plain = f.prepare_params(session, "main");
    plain["restoreOnly"] = json!(true);
    assert_eq!(
        code(
            &f.call("workspaceGit.prepare", plain.clone())
                .await
                .unwrap_err()
        ),
        "WORKSPACE_GIT_FAILED"
    );
    assert!(!path.exists());

    let mut restore = strict(&f, session);
    restore["environment"] =
        json!({"variables": [], "setupScript": "printf partial > progress.txt\nexit 4"});
    let job_id = f.start_prepare(restore).await;
    let (job, _) = f.wait(&job_id).await;
    assert_eq!(job["state"], "failed", "{job}");
    assert_eq!(job["error"]["code"], "WORKSPACE_GIT_SETUP_FAILED");
    assert_eq!(job["worktree"]["reclaimedAt"], result["reclaimedAt"]);
    assert_eq!(job["worktree"]["reclaimedCommit"], commit);
    assert_eq!(job["worktree"]["checkoutPresent"], true);
    assert_eq!(job["worktree"]["setup"]["status"], "failed");
    assert_eq!(
        fs::read_to_string(path.join("progress.txt")).unwrap(),
        "partial"
    );
    fs::write(path.join("progress.txt"), "user edit").unwrap();

    // A forgotten job must not allow legacy prepare or tools to see a ready checkout.
    *f.state.lock().await = {
        let mut state = AppState::open(&f.dir.path().join("data")).unwrap();
        state.handshook = true;
        state
    };
    assert_eq!(
        code(
            &f.call("workspaceGit.job", json!({"jobId": job_id}))
                .await
                .unwrap_err()
        ),
        "WORKSPACE_GIT_JOB_NOT_FOUND"
    );
    let listed = f
        .call("workspaceGit.list", json!({"installationId": INSTALLATION}))
        .await
        .unwrap();
    assert_eq!(listed["worktrees"][0]["reclaimedCommit"], commit);
    assert_eq!(
        code(&f.call("workspaceGit.prepare", plain).await.unwrap_err()),
        "WORKSPACE_GIT_FAILED"
    );
    let (tx, _rx) = mpsc::unbounded_channel();
    let refused = handle_request(
        f.state.clone(),
        "tools.workspaceExecute",
        json!({
            "path": path, "sessionId": session, "toolCallId": "blocked-tool", "toolName": "Read",
            "args": {"path": "README.md"}
        }),
        tx,
    )
    .await
    .unwrap_err();
    assert_eq!(code(&refused), "REMOTE_WORKSPACE_NOT_READY");

    let mut restore = strict(&f, session);
    restore["environment"] = json!({"variables": [], "setupScript": "test -f progress.txt && printf ready > finished.txt"});
    let (job, _) = f.wait(&f.start_prepare(restore).await).await;
    assert_eq!(job["state"], "succeeded", "{job}");
    assert!(job["worktree"].get("reclaimedAt").is_none());
    assert_eq!(job["worktree"]["setup"]["status"], "ok");
    assert_eq!(rev_parse(&path, "HEAD"), commit);
    assert_eq!(
        fs::read_to_string(path.join("progress.txt")).unwrap(),
        "user edit"
    );
    assert_eq!(
        fs::read_to_string(path.join("finished.txt")).unwrap(),
        "ready"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn reclaim_compacts_loose_objects_without_expiring_shared_repository_state() {
    let f = Fixture::new();
    let session = "compact";
    f.prepare(session, "main").await;
    let main = f.main_path();
    let path = f.worktree_path(session);
    let reclaimed_commit = commit_file(&path, "published.txt", "published");
    publish(&path);

    let unknown = f.dir.path().join("unknown-worktree");
    git_cmd(
        &main,
        &["worktree", "add", "--detach", unknown.to_str().unwrap()],
    );
    let detached_commit = commit_file(&unknown, "private.txt", "unpublished detached commit");
    fs::write(unknown.join("dirty"), "work in progress").unwrap();
    fs::write(main.join("main-local"), "main checkout data").unwrap();

    let history_ref = "refs/heads/local-history";
    let main_commit = rev_parse(&main, "HEAD");
    git_cmd(
        &main,
        &[
            "update-ref",
            "--create-reflog",
            history_ref,
            &detached_commit,
        ],
    );
    let reflog_commit = commit_file(&unknown, "private.txt", "reflog-only commit");
    git_cmd(&main, &["update-ref", history_ref, &reflog_commit]);
    git_cmd(&main, &["update-ref", history_ref, &main_commit]);
    git_cmd(&unknown, &["checkout", "--detach", &detached_commit]);

    // The redundant loose copy should be deleted, while a loose object that
    // only exists here must survive even under aggressive user GC settings.
    git_cmd(&main, &["config", "gc.pruneExpire", "now"]);
    git_cmd(&main, &["config", "gc.reflogExpire", "now"]);
    git_cmd(&main, &["config", "gc.reflogExpireUnreachable", "now"]);
    git_cmd(&main, &["config", "gc.worktreePruneExpire", "now"]);
    let orphan_file = f.dir.path().join("orphan");
    fs::write(&orphan_file, "unreachable payload").unwrap();
    let orphan = git_cmd(&main, &["hash-object", "-w", orphan_file.to_str().unwrap()]);
    let loose_object = |oid: &str| main.join(".git/objects").join(&oid[..2]).join(&oid[2..]);
    assert!(loose_object(&reclaimed_commit).is_file());
    let refs = git_cmd(&main, &["show-ref", "--head"]);
    let reflog = git_cmd(&main, &["reflog", "show", history_ref]);
    let checkout_reflog = git_cmd(&unknown, &["reflog", "show", "HEAD"]);

    assert_eq!(reclaim(&f, session).await["reclaimed"], true);
    assert!(!loose_object(&reclaimed_commit).exists());
    assert!(loose_object(orphan.trim()).is_file());
    assert_eq!(git_cmd(&main, &["show-ref", "--head"]), refs);
    assert_eq!(git_cmd(&main, &["reflog", "show", history_ref]), reflog);
    assert_eq!(
        git_cmd(&unknown, &["reflog", "show", "HEAD"]),
        checkout_reflog
    );
    assert_eq!(rev_parse(&unknown, "HEAD"), detached_commit);
    assert_eq!(
        git_cmd(&main, &["cat-file", "-t", &reflog_commit]).trim(),
        "commit"
    );
    assert_eq!(
        fs::read_to_string(unknown.join("dirty")).unwrap(),
        "work in progress"
    );
    assert_eq!(
        fs::read_to_string(main.join("main-local")).unwrap(),
        "main checkout data"
    );
    assert_eq!(worktree_count(&main), 2);
    let (job, _) = f.wait(&f.start_prepare(strict(&f, session)).await).await;
    assert_eq!(job["state"], "succeeded", "{job}");
    assert_eq!(rev_parse(&path, "HEAD"), reclaimed_commit);
}

#[cfg(unix)]
#[tokio::test]
async fn reclaim_skips_compaction_of_redirected_objects_and_can_still_wake() {
    use std::os::unix::fs::symlink;

    let f = Fixture::new();
    let session = "redirected-objects";
    f.prepare(session, "main").await;
    let path = f.worktree_path(session);
    let commit = commit_file(&path, "published.txt", "published");
    publish(&path);

    let fanout = f.main_path().join(".git/objects").join(&commit[..2]);
    let outside = f.dir.path().join("outside-object-store");
    fs::rename(&fanout, &outside).unwrap();
    symlink(&outside, &fanout).unwrap();
    let object = outside.join(&commit[2..]);
    let content = fs::read(&object).unwrap();

    assert_eq!(reclaim(&f, session).await["reclaimed"], true);
    assert_eq!(fs::read(&object).unwrap(), content);
    assert!(!path.exists());
    let (job, _) = f.wait(&f.start_prepare(strict(&f, session)).await).await;
    assert_eq!(job["state"], "succeeded", "{job}");
    assert_eq!(rev_parse(&path, "HEAD"), commit);
}

#[tokio::test]
async fn reclaim_does_not_remove_dirty_unpublished_or_ignored_files() {
    let f = Fixture::new();
    let session = "protected";
    f.prepare(session, "main").await;
    let path = f.worktree_path(session);
    commit_file(&path, ".gitignore", ".env\n.pi/\ncache/\n");
    publish(&path);
    fs::write(path.join(".env"), "local settings").unwrap();
    let result = reclaim(&f, session).await;
    assert_eq!(
        result,
        json!({"reclaimed": false, "reason": "protectedIgnoredFiles", "uncommittedFiles": 0, "unpushedCommits": 0, "protectedIgnoredFiles": 1})
    );
    fs::remove_file(path.join(".env")).unwrap();

    fs::create_dir(path.join(".pi")).unwrap();
    fs::write(
        path.join(".pi/workspace.json"),
        r#"{"reclaim":{"regenerableDirs":["cache"]}}"#,
    )
    .unwrap();
    fs::create_dir(path.join("cache")).unwrap();
    fs::write(path.join("cache/keep"), "keep").unwrap();
    let result = reclaim(&f, session).await;
    assert_eq!(result["reason"], "protectedIgnoredFiles");
    assert_eq!(result["protectedIgnoredFiles"], 2);
    fs::remove_dir_all(path.join(".pi")).unwrap();
    fs::remove_dir_all(path.join("cache")).unwrap();

    fs::write(path.join("scratch"), "uncommitted").unwrap();
    fs::write(path.join("README.md"), "edited").unwrap();
    git_cmd(&path, &["add", "--", "README.md"]);
    let result = reclaim(&f, session).await;
    assert_eq!(result["reason"], "uncommittedChanges");
    assert_eq!(result["uncommittedFiles"], 2);
    commit_file(&path, "scratch", "unpublished");
    let result = reclaim(&f, session).await;
    assert_eq!(result["reason"], "unpushedCommits");
    assert_eq!(result["unpushedCommits"], 1);
    assert_eq!(
        fs::read_to_string(path.join("scratch")).unwrap(),
        "unpublished"
    );
}

#[tokio::test]
async fn reclaim_refuses_ambiguous_index_git_state_and_accidentally_missing_checkout() {
    let f = Fixture::new();
    let session = "ambiguous";
    f.prepare(session, "main").await;
    let path = f.worktree_path(session);
    for (set, clear) in [
        ("--assume-unchanged", "--no-assume-unchanged"),
        ("--skip-worktree", "--no-skip-worktree"),
    ] {
        git_cmd(&path, &["update-index", set, "README.md"]);
        assert_eq!(reclaim(&f, session).await["reason"], "gitStateUncertain");
        git_cmd(&path, &["update-index", clear, "README.md"]);
    }
    git_cmd(&path, &["config", "core.sparseCheckout", "true"]);
    assert_eq!(reclaim(&f, session).await["reason"], "gitStateUncertain");
    git_cmd(&path, &["config", "--unset", "core.sparseCheckout"]);
    let git_dir = git_cmd(&path, &["rev-parse", "--absolute-git-dir"]);
    let operation = Path::new(git_dir.trim()).join("sequencer");
    fs::create_dir(&operation).unwrap();
    assert_eq!(reclaim(&f, session).await["reason"], "gitStateUncertain");
    fs::remove_dir(&operation).unwrap();
    git_cmd(&path, &["checkout", "--detach", "HEAD"]);
    assert_eq!(reclaim(&f, session).await["reason"], "gitStateUncertain");
    fs::remove_dir_all(&path).unwrap();
    assert_eq!(reclaim(&f, session).await["reason"], "gitStateUncertain");
    let list = f
        .call("workspaceGit.list", json!({"installationId": INSTALLATION}))
        .await
        .unwrap();
    assert_eq!(list["worktrees"][0]["checkoutPresent"], false);
    assert!(list["worktrees"][0].get("reclaimedAt").is_none());
}

#[cfg(unix)]
#[tokio::test]
async fn reclaim_preserves_symlinked_build_roots_and_rejects_undecodable_paths() {
    use std::os::unix::{ffi::OsStrExt, fs::symlink};
    let f = Fixture::new();
    let session = "links";
    f.prepare(session, "main").await;
    let path = f.worktree_path(session);
    commit_file(&path, ".gitignore", "node_modules\n");
    publish(&path);
    let outside = f.dir.path().join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("keep"), "keep").unwrap();
    symlink(&outside, path.join("node_modules")).unwrap();
    assert_eq!(
        reclaim(&f, session).await["reason"],
        "protectedIgnoredFiles"
    );
    assert!(outside.join("keep").exists());
    fs::remove_file(path.join("node_modules")).unwrap();
    fs::write(
        path.join(std::ffi::OsStr::from_bytes(b"invalid-\xff")),
        "keep",
    )
    .unwrap();
    assert_eq!(reclaim(&f, session).await["reason"], "gitStateUncertain");
}

#[tokio::test]
async fn reclaim_shares_the_managed_tool_and_git_job_admission_lock() {
    let f = Fixture::new();
    let session = "busy";
    f.prepare(session, "main").await;
    let locks = f.state.lock().await.workspace_git_locks.clone();
    let tool = locks.try_read(INSTALLATION, session).unwrap();
    let result = reclaim(&f, session).await;
    assert_eq!(
        result,
        json!({"reclaimed": false, "reason": "busy", "uncommittedFiles": 0, "unpushedCommits": 0, "protectedIgnoredFiles": 0})
    );
    let prepare = f
        .call("workspaceGit.prepare", strict(&f, session))
        .await
        .unwrap_err();
    assert_eq!(code(&prepare), "WORKSPACE_GIT_BUSY");
    let removal = f
        .call("workspaceGit.removeSafely", f.session(session))
        .await
        .unwrap_err();
    assert_eq!(code(&removal), "WORKSPACE_GIT_BUSY");
    let mut push = f.session(session);
    push["gitProxy"] = f.proxy();
    let push = f.call("workspaceGit.push", push).await.unwrap_err();
    assert_eq!(code(&push), "WORKSPACE_GIT_BUSY");
    drop(tool);
    assert_eq!(reclaim(&f, session).await["reclaimed"], true);
}

#[tokio::test]
async fn strict_wake_refuses_a_moved_retained_ref() {
    let f = Fixture::new();
    let session = "moved-ref";
    f.prepare(session, "main").await;
    let path = f.worktree_path(session);
    let result = reclaim(&f, session).await;
    assert_eq!(result["reclaimed"], true, "{result}");
    let main = f.main_path();
    let branch = format!("refs/heads/{}", work_branch(INSTALLATION, session));
    let moved = rev_parse(&main, "refs/remotes/origin/develop");
    git_cmd(&main, &["update-ref", &branch, &moved]);
    let (job, _) = f.wait(&f.start_prepare(strict(&f, session)).await).await;
    assert_eq!(job["state"], "failed", "{job}");
    assert_eq!(job["error"]["code"], "WORKSPACE_GIT_FAILED");
    assert!(!path.exists());
    assert_eq!(rev_parse(&main, &branch), moved);
}

#[tokio::test]
async fn an_interrupted_reclaim_preserves_the_pending_checkout_and_blocks_wake() {
    let f = Fixture::new();
    let session = "pending";
    f.prepare(session, "main").await;
    let path = f.worktree_path(session);
    let commit = rev_parse(&path, "HEAD");
    let intent = ReclaimIntent {
        quarantine_id: uuid::Uuid::new_v4().to_string(),
        admin_name: short_id(INSTALLATION, session),
        quarantined: false,
    };
    {
        let state = f.state.lock().await;
        let mut record = registry::get(&state.db, INSTALLATION, session)
            .unwrap()
            .unwrap();
        record.recovery.reclaimed_at = Some("2026-11-21T00:00:00.000Z".into());
        record.recovery.reclaimed_commit = Some(commit.clone());
        record.recovery.reclaim_intent = Some(intent);
        record.setup_status = SetupStatus::None;
        registry::insert(&state.db, &record).unwrap();
    }
    fs::write(path.join("preserve"), "keep").unwrap();
    assert_eq!(
        code(
            &f.call("workspaceGit.reclaim", f.session(session))
                .await
                .unwrap_err()
        ),
        "WORKSPACE_GIT_FAILED"
    );
    assert_eq!(
        code(
            &f.call("workspaceGit.prepare", strict(&f, session))
                .await
                .unwrap_err()
        ),
        "WORKSPACE_GIT_FAILED"
    );
    let list = f
        .call("workspaceGit.list", json!({"installationId": INSTALLATION}))
        .await
        .unwrap();
    assert_eq!(list["worktrees"][0]["checkoutPresent"], false);
    assert_eq!(list["worktrees"][0]["reclaimedCommit"], commit);
    assert_eq!(fs::read_to_string(path.join("preserve")).unwrap(), "keep");
}
