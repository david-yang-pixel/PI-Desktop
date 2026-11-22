//! A prepare that stops while it creates the worktree: cancelled, failed, or
//! cut short by a host-core restart. It must never leave a work branch or a
//! checkout that no registration owns.

use std::fs;

use super::*;
use crate::workspace_git::registry::{self, Recovery};

/// A git that fails the named subcommands, after every other step ran, while
/// the marker from `injection` exists. The marker is created with it.
#[cfg(unix)]
fn failing(pattern: &'static str) -> Fixture {
    Fixture::with_git(|base| {
        use std::os::unix::fs::PermissionsExt;
        let marker = base.join("inject-failure");
        let script = base.join("failing-git");
        fs::write(
            &script,
            format!(
                "#!/bin/sh\nif [ -e '{}' ]; then case \" $* \" in {pattern}) echo injected failure >&2; exit 1;; esac; fi\nexec git \"$@\"\n",
                marker.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(&marker, "").unwrap();
        GitRunner::with_program(script)
    })
}

#[cfg(unix)]
fn injection(f: &Fixture) -> PathBuf {
    crate::workspace::simple_canonicalize(f.dir.path())
        .unwrap()
        .join("inject-failure")
}

/// The same host with a git that is neither slow nor failing.
#[cfg(unix)]
fn healthy(f: Fixture) -> Fixture {
    Fixture {
        context: Arc::new(WorkspaceGitContext::with_remote_base(&f.remote.base())),
        ..f
    }
}

fn has_local_branch(main: &Path, session: &str) -> bool {
    std::process::Command::new("git")
        .arg("-C")
        .arg(main)
        .args(["show-ref", "--verify", "--quiet"])
        .arg(format!("refs/heads/{}", work_branch(INSTALLATION, session)))
        .status()
        .unwrap()
        .success()
}

async fn listed_sessions(f: &Fixture) -> Vec<String> {
    let listed = f
        .call(
            "workspaceGit.list",
            json!({ "installationId": INSTALLATION }),
        )
        .await
        .unwrap();
    listed["worktrees"]
        .as_array()
        .unwrap()
        .iter()
        .map(|worktree| worktree["sessionId"].as_str().unwrap().to_string())
        .collect()
}

async fn edit_recovery(f: &Fixture, session: &str, edit: impl FnOnce(&mut Recovery)) {
    let state = f.state.lock().await;
    let mut record = registry::get(&state.db, INSTALLATION, session)
        .unwrap()
        .unwrap();
    edit(&mut record.recovery);
    registry::insert(&state.db, &record).unwrap();
}

/// Nothing of the session is left: no checkout, no git entry for it, no
/// branch, no registration. The main checkout stays.
async fn assert_nothing_left(f: &Fixture, session: &str) {
    assert!(!f.worktree_path(session).exists());
    assert!(!has_local_branch(&f.main_path(), session));
    assert_eq!(worktree_count(&f.main_path()), 1);
    assert!(f.main_path().join("README.md").is_file());
    assert!(!listed_sessions(f).await.contains(&session.to_string()));
    let error = f
        .call("workspaceGit.status", f.session(session))
        .await
        .unwrap_err();
    assert_eq!(code(&error), "WORKSPACE_GIT_NOT_FOUND");
}

#[cfg(unix)]
#[tokio::test]
async fn cancelling_during_worktree_creation_leaves_nothing_and_a_retry_succeeds() {
    // `git worktree add` completes; the step after it stalls.
    let f = Fixture::slow("*' worktree lock '*", "30");
    let path = f.worktree_path("session-1");
    let job_id = f.start_prepare(f.prepare_params("session-1", "main")).await;
    for _ in 0..1000 {
        if path.join("README.md").is_file() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(path.join("README.md").is_file());
    assert!(has_local_branch(&f.main_path(), "session-1"));

    let started = std::time::Instant::now();
    f.call("workspaceGit.jobCancel", json!({ "jobId": job_id }))
        .await
        .unwrap();
    let job = f
        .call("workspaceGit.job", json!({ "jobId": job_id }))
        .await
        .unwrap();
    assert_eq!(job["state"], "cancelled", "{job}");
    assert_eq!(job["phase"], "creatingWorktree");
    assert!(started.elapsed() < Duration::from_secs(10));
    assert_nothing_left(&f, "session-1").await;

    let retry = healthy(f);
    let worktree = retry.prepare("session-1", "main").await;
    assert_eq!(worktree["baseCommit"], retry.remote.head("main"));
    assert!(path.join("README.md").is_file());
    assert_eq!(worktree_count(&retry.main_path()), 2);
}

#[cfg(unix)]
#[tokio::test]
async fn a_failure_after_the_worktree_is_added_rolls_it_back_and_a_retry_succeeds() {
    let f = failing("*' worktree lock '*");
    let job_id = f.start_prepare(f.prepare_params("session-1", "main")).await;
    let (job, _phases) = f.wait(&job_id).await;
    assert_eq!(job["state"], "failed", "{job}");
    assert_eq!(job["phase"], "creatingWorktree");
    assert_nothing_left(&f, "session-1").await;

    let retry = healthy(f);
    let worktree = retry.prepare("session-1", "main").await;
    assert_eq!(worktree["baseCommit"], retry.remote.head("main"));
    assert!(retry.worktree_path("session-1").join("README.md").is_file());
}

#[cfg(unix)]
#[tokio::test]
async fn a_failure_rolls_back_a_worktree_created_in_an_empty_directory() {
    let f = failing("*' worktree lock '*");
    fs::create_dir_all(f.worktree_path("session-1")).unwrap();
    let job_id = f.start_prepare(f.prepare_params("session-1", "main")).await;
    let (job, _phases) = f.wait(&job_id).await;
    assert_eq!(job["state"], "failed", "{job}");
    assert_nothing_left(&f, "session-1").await;
}

#[cfg(unix)]
#[tokio::test]
async fn a_failure_while_configuring_the_branch_rolls_back_a_forked_session() {
    let f = failing("*' config --local -- branch.'*");
    fs::remove_file(injection(&f)).unwrap();
    f.prepare("parent", "main").await;
    fs::write(injection(&f), "").unwrap();
    let parent_head = commit_file(&f.worktree_path("parent"), "parent.txt", "unpushed");

    let mut params = f.prepare_params("child", "main");
    params["fromSessionId"] = json!("parent");
    let (job, _phases) = f.wait(&f.start_prepare(params).await).await;
    assert_eq!(job["state"], "failed", "{job}");
    assert!(!f.worktree_path("child").exists());
    assert!(!has_local_branch(&f.main_path(), "child"));
    assert_eq!(listed_sessions(&f).await, ["parent"]);
    // The parent's branch, with its unpushed commit, is untouched.
    let parent_ref = format!("refs/heads/{}", work_branch(INSTALLATION, "parent"));
    assert_eq!(rev_parse(&f.main_path(), &parent_ref), parent_head);
    assert_eq!(rev_parse(&f.worktree_path("parent"), "HEAD"), parent_head);
}

#[tokio::test]
async fn files_already_at_the_worktree_path_are_never_removed() {
    let f = Fixture::new();
    let path = f.worktree_path("session-1");
    fs::create_dir_all(&path).unwrap();
    fs::write(path.join("mine.txt"), "not git's").unwrap();
    let job_id = f.start_prepare(f.prepare_params("session-1", "main")).await;
    let (job, _phases) = f.wait(&job_id).await;
    assert_eq!(job["state"], "failed", "{job}");
    assert_eq!(
        fs::read_to_string(path.join("mine.txt")).unwrap(),
        "not git's"
    );
    assert!(!has_local_branch(&f.main_path(), "session-1"));
    assert!(listed_sessions(&f).await.is_empty());
}

#[tokio::test]
async fn an_unregistered_work_branch_is_never_deleted() {
    let f = Fixture::new();
    f.prepare("session-1", "main").await;
    // A branch with this session's name that no registration owns, for
    // example one an older host-core left behind.
    let branch = work_branch(INSTALLATION, "session-2");
    let develop = rev_parse(&f.main_path(), "refs/remotes/origin/develop");
    git_cmd(&f.main_path(), &["branch", "--", &branch, &develop]);

    let job_id = f.start_prepare(f.prepare_params("session-2", "main")).await;
    let (job, _phases) = f.wait(&job_id).await;
    assert_eq!(job["state"], "failed", "{job}");
    assert_eq!(job["error"]["code"], "WORKSPACE_GIT_FAILED");
    assert_eq!(
        rev_parse(&f.main_path(), &format!("refs/heads/{branch}")),
        develop
    );
    assert!(!f.worktree_path("session-2").exists());
    assert_eq!(listed_sessions(&f).await, ["session-1"]);
}

/// A reclaimed session whose strict restore stopped after `git worktree add`
/// started: the registration says the checkout is being created, and a
/// partial checkout is on disk.
async fn interrupted_restore(f: &Fixture, session: &str) -> String {
    f.prepare(session, "main").await;
    let path = f.worktree_path(session);
    git_cmd(&path, &["push", "origin", "HEAD"]);
    let reclaimed = f
        .call("workspaceGit.reclaim", f.session(session))
        .await
        .unwrap();
    assert_eq!(reclaimed["reclaimed"], true, "{reclaimed}");
    let commit = reclaimed["commit"].as_str().unwrap().to_string();
    edit_recovery(f, session, |recovery| {
        recovery.strict_setup_pending = true;
        recovery.checkout_creation_pending = true;
    })
    .await;
    git_cmd(
        &f.main_path(),
        &[
            "worktree",
            "add",
            "-q",
            "--lock",
            "--",
            path.to_str().unwrap(),
            &work_branch(INSTALLATION, session),
        ],
    );
    fs::remove_file(path.join("README.md")).unwrap();
    commit
}

#[tokio::test]
async fn an_interrupted_restore_is_retried_from_a_clean_checkout() {
    let f = Fixture::new();
    let session = "restore";
    let commit = interrupted_restore(&f, session).await;
    let path = f.worktree_path(session);

    let mut strict = f.prepare_params(session, "main");
    strict["restoreOnly"] = json!(true);
    strict["rerunSetup"] = json!(true);
    strict["requireSetupSuccess"] = json!(true);
    let (job, _phases) = f.wait(&f.start_prepare(strict).await).await;
    assert_eq!(job["state"], "succeeded", "{job}");
    assert_eq!(job["worktree"]["checkoutPresent"], true);
    assert!(job["worktree"].get("reclaimedAt").is_none());
    assert_eq!(rev_parse(&path, "HEAD"), commit);
    assert!(path.join("README.md").is_file());
    assert_eq!(worktree_count(&f.main_path()), 2);
}

#[tokio::test]
async fn an_interrupted_restore_can_be_removed() {
    let f = Fixture::new();
    let session = "restore";
    interrupted_restore(&f, session).await;
    let removed = f
        .call("workspaceGit.removeSafely", f.session(session))
        .await
        .unwrap();
    assert_eq!(
        removed,
        json!({ "removed": true, "uncommittedFiles": 0, "unpushedCommits": 0 })
    );
    assert_nothing_left(&f, session).await;
}

/// What a host-core restart during `git worktree add` leaves: a registration
/// still marked unfinished, the work branch at its start commit, and a
/// checkout git linked but never filled.
async fn unfinished_creation(f: &Fixture, session: &str) -> PathBuf {
    f.prepare(session, "main").await;
    let path = f.worktree_path(session);
    let main = f.main_path();
    let branch = work_branch(INSTALLATION, session);
    git_cmd(&main, &["worktree", "unlock", "--", path.to_str().unwrap()]);
    git_cmd(
        &main,
        &[
            "worktree",
            "remove",
            "--force",
            "--",
            path.to_str().unwrap(),
        ],
    );
    git_cmd(&main, &["branch", "-D", "--", &branch]);
    git_cmd(
        &main,
        &[
            "worktree",
            "add",
            "-q",
            "--no-checkout",
            "-b",
            &branch,
            "--",
            path.to_str().unwrap(),
            &f.remote.head("main"),
        ],
    );
    edit_recovery(f, session, |recovery| {
        recovery.checkout_creation_pending = true;
        recovery.branch_creation_pending = true;
    })
    .await;
    path
}

#[tokio::test]
async fn an_unfinished_creation_is_not_a_worktree_until_it_is_rolled_back() {
    let f = Fixture::new();
    let path = unfinished_creation(&f, "session-1").await;
    // Listed, so a reconcile can remove it, but nothing else treats it as a
    // worktree.
    let listed = f
        .call(
            "workspaceGit.list",
            json!({ "installationId": INSTALLATION }),
        )
        .await
        .unwrap();
    assert_eq!(listed["worktrees"][0]["checkoutPresent"], false);
    let status = f
        .call("workspaceGit.status", f.session("session-1"))
        .await
        .unwrap_err();
    assert_eq!(code(&status), "WORKSPACE_GIT_NOT_FOUND");
    let mut restore = f.prepare_params("session-1", "main");
    restore["restoreOnly"] = json!(true);
    let error = f.call("workspaceGit.prepare", restore).await.unwrap_err();
    assert_eq!(code(&error), "WORKSPACE_GIT_NOT_FOUND");
    let mut push = f.session("session-1");
    push["gitProxy"] = f.proxy();
    let error = f.call("workspaceGit.push", push).await.unwrap_err();
    assert_eq!(code(&error), "WORKSPACE_GIT_NOT_FOUND");
    let error = f
        .call("workspaceGit.reclaim", f.session("session-1"))
        .await
        .unwrap_err();
    assert_eq!(code(&error), "WORKSPACE_GIT_NOT_FOUND");

    // The next prepare rolls it back and starts from the current base.
    let head = f.remote.commit("main", "later.txt", "later\n");
    let worktree = f.prepare("session-1", "main").await;
    assert_eq!(worktree["baseCommit"], head);
    assert_eq!(worktree["checkoutPresent"], true);
    assert_eq!(rev_parse(&path, "HEAD"), head);
    assert!(path.join("later.txt").is_file());
    assert_eq!(worktree_count(&f.main_path()), 2);
}

#[tokio::test]
async fn an_unfinished_creation_is_removed_without_force() {
    let f = Fixture::new();
    unfinished_creation(&f, "session-1").await;
    let removed = f
        .call("workspaceGit.removeSafely", f.session("session-1"))
        .await
        .unwrap();
    assert_eq!(
        removed,
        json!({ "removed": true, "uncommittedFiles": 0, "unpushedCommits": 0 })
    );
    assert_nothing_left(&f, "session-1").await;
}

#[tokio::test]
async fn an_empty_checkout_directory_of_an_unfinished_creation_is_rolled_back() {
    let f = Fixture::new();
    let path = unfinished_creation(&f, "session-1").await;
    // git stopped right after it created the directory.
    git_cmd(
        &f.main_path(),
        &[
            "worktree",
            "remove",
            "--force",
            "--",
            path.to_str().unwrap(),
        ],
    );
    fs::create_dir(&path).unwrap();
    let worktree = f.prepare("session-1", "main").await;
    assert_eq!(worktree["checkoutPresent"], true);
    assert!(path.join("README.md").is_file());
}

#[tokio::test]
async fn an_unfinished_creation_whose_branch_gained_a_commit_is_kept_until_forced() {
    let f = Fixture::new();
    let path = unfinished_creation(&f, "session-1").await;
    git_cmd(&path, &["reset", "-q", "--hard"]);
    let head = commit_file(&path, "work.txt", "do not lose this");

    let job_id = f.start_prepare(f.prepare_params("session-1", "main")).await;
    let (job, _phases) = f.wait(&job_id).await;
    assert_eq!(job["state"], "failed", "{job}");
    assert_eq!(job["error"]["code"], "WORKSPACE_GIT_FAILED");
    assert_eq!(rev_parse(&path, "HEAD"), head);
    assert_eq!(
        fs::read_to_string(path.join("work.txt")).unwrap(),
        "do not lose this"
    );

    let refused = f
        .call("workspaceGit.removeSafely", f.session("session-1"))
        .await
        .unwrap();
    assert_eq!(
        refused,
        json!({ "removed": false, "uncommittedFiles": 0, "unpushedCommits": 1 })
    );
    assert!(has_local_branch(&f.main_path(), "session-1"));
    let mut forced = f.session("session-1");
    forced["force"] = json!(true);
    let removed = f.call("workspaceGit.remove", forced).await.unwrap();
    assert_eq!(removed["removed"], true, "{removed}");
    assert_nothing_left(&f, "session-1").await;
}

#[cfg(unix)]
#[tokio::test]
async fn a_cancelled_setup_whose_cleanup_failed_is_finished_by_the_next_prepare() {
    let f = failing("*' worktree remove '*");
    fs::remove_file(injection(&f)).unwrap();
    let mut params = f.prepare_params("session-1", "main");
    params["environment"] = json!({ "variables": [], "setupScript": "sleep 30" });
    let job_id = f.start_prepare(params).await;
    for _ in 0..1000 {
        let job = f
            .call("workspaceGit.job", json!({ "jobId": job_id }))
            .await
            .unwrap();
        if job["phase"] == "runningSetup" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    fs::write(injection(&f), "").unwrap();
    f.call("workspaceGit.jobCancel", json!({ "jobId": job_id }))
        .await
        .unwrap();
    let job = f
        .call("workspaceGit.job", json!({ "jobId": job_id }))
        .await
        .unwrap();
    assert_eq!(job["state"], "cancelled", "{job}");
    // The registration outlives the leftover it owns.
    assert_eq!(listed_sessions(&f).await, ["session-1"]);
    assert!(has_local_branch(&f.main_path(), "session-1"));
    let error = f
        .call("workspaceGit.status", f.session("session-1"))
        .await
        .unwrap_err();
    assert_eq!(code(&error), "WORKSPACE_GIT_NOT_FOUND");

    fs::remove_file(injection(&f)).unwrap();
    let worktree = f.prepare("session-1", "main").await;
    assert_eq!(worktree["checkoutPresent"], true);
    assert!(f.worktree_path("session-1").join("README.md").is_file());
    assert_eq!(worktree_count(&f.main_path()), 2);
}

/// A reclaim that stopped after recording its intent; `quarantined` says
/// whether it moved the checkout into its quarantine first.
async fn interrupted_reclaim(f: &Fixture, session: &str, quarantined: bool) -> PathBuf {
    f.prepare(session, "main").await;
    let path = f.worktree_path(session);
    let intent = registry::ReclaimIntent {
        quarantine_id: uuid::Uuid::new_v4().to_string(),
        admin_name: short_id(INSTALLATION, session),
        quarantined,
    };
    let quarantine = crate::workspace_git::reclaim::quarantine_path(&path, &intent).unwrap();
    fs::create_dir(&quarantine).unwrap();
    if quarantined {
        fs::rename(&path, quarantine.join("checkout")).unwrap();
    }
    let commit = f.remote.head("main");
    edit_recovery(f, session, |recovery| {
        recovery.reclaimed_at = Some("2026-11-21T00:00:00.000Z".into());
        recovery.reclaimed_commit = Some(commit);
        recovery.reclaim_intent = Some(intent);
    })
    .await;
    quarantine
}

#[tokio::test]
async fn an_interrupted_reclaim_is_removed_only_with_force() {
    for quarantined in [false, true] {
        let f = Fixture::new();
        let quarantine = interrupted_reclaim(&f, "session-1", quarantined).await;
        let error = f
            .call("workspaceGit.removeSafely", f.session("session-1"))
            .await
            .unwrap_err();
        assert_eq!(code(&error), "WORKSPACE_GIT_FAILED");
        assert_eq!(listed_sessions(&f).await, ["session-1"]);

        let mut forced = f.session("session-1");
        forced["force"] = json!(true);
        let removed = f.call("workspaceGit.remove", forced).await.unwrap();
        assert_eq!(removed["removed"], true, "{removed}");
        assert!(!quarantine.exists(), "quarantined: {quarantined}");
        assert_nothing_left(&f, "session-1").await;
    }
}
