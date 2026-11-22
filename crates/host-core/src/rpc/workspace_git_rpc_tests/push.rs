//! Pushing a work branch: what the session and the repository can do while
//! the transfer runs, and how a refused push is reported.

use super::*;
use crate::session_worktrees::repo_lock;
use crate::workspace_git::repository::common_dir;

fn push_params(f: &Fixture, session: &str) -> Value {
    let mut params = f.session(session);
    params["gitProxy"] = f.proxy();
    params
}

/// Wait until `ready` holds while the job is still running.
async fn while_running(f: &Fixture, job_id: &str, mut ready: impl FnMut() -> bool) -> bool {
    for _ in 0..500 {
        let job = f
            .call("workspaceGit.job", json!({ "jobId": job_id }))
            .await
            .unwrap();
        if job["state"] != "running" {
            return false;
        }
        if job["phase"] == "pushing" && ready() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    false
}

#[cfg(unix)]
#[tokio::test]
async fn the_worktree_and_the_repository_stay_usable_while_a_push_transfers() {
    let f = Fixture::slow("*' push '*", "1");
    f.prepare("session-1", "main").await;
    let path = f.worktree_path("session-1");
    let head = commit_file(&path, "work.txt", "work\n");
    let started = f
        .call("workspaceGit.push", push_params(&f, "session-1"))
        .await
        .unwrap();
    let job_id = started["jobId"].as_str().unwrap().to_string();
    let locks = f.state.lock().await.workspace_git_locks.clone();
    // The session's tools are not refused for the length of the transfer.
    assert!(
        while_running(&f, &job_id, || locks
            .try_read(INSTALLATION, "session-1")
            .is_some())
        .await,
        "the worktree stayed locked during the push"
    );
    // Nor is the repository: another session's worktree step can run.
    assert!(repo_lock::try_lock(&common_dir(&f.main_path())).is_some());
    let status = f
        .call("workspaceGit.status", f.session("session-1"))
        .await
        .unwrap();
    assert_eq!(status["unpushedCommits"], 1);
    // The running job still keeps exclusive steps of this session away.
    let mut remove = f.session("session-1");
    remove["force"] = json!(true);
    let error = f.call("workspaceGit.remove", remove).await.unwrap_err();
    assert_eq!(code(&error), "WORKSPACE_GIT_BUSY");
    assert_eq!(error.data.as_ref().unwrap()["jobId"], json!(job_id));
    let error = f
        .call("workspaceGit.push", push_params(&f, "session-1"))
        .await
        .unwrap_err();
    assert_eq!(code(&error), "WORKSPACE_GIT_BUSY");

    let (job, _phases) = f.wait(&job_id).await;
    assert_eq!(job["state"], "succeeded", "{job}");
    assert_eq!(job["pushed"]["remoteHead"], head);
    assert_eq!(f.remote.head(&work_branch(INSTALLATION, "session-1")), head);
}
