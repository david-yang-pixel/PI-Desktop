//! The repository lock: who holds it, for how long, and what a request
//! answered inline does when it cannot get it.

use super::*;
use crate::session_worktrees::repo_lock;
use crate::workspace_git::repository::common_dir;

#[tokio::test]
async fn removal_answers_busy_instead_of_waiting_out_a_held_repository() {
    let f = Fixture::new();
    f.prepare("session-1", "main").await;
    let held = repo_lock::lock(&common_dir(&f.main_path())).await;
    let mut remove = f.session("session-1");
    remove["force"] = json!(false);
    // Well inside any request budget.
    let error = tokio::time::timeout(
        Duration::from_secs(10),
        f.call("workspaceGit.remove", remove.clone()),
    )
    .await
    .expect("removal waited for the repository")
    .unwrap_err();
    assert_eq!(code(&error), "WORKSPACE_GIT_BUSY", "{error:?}");
    // Nothing was removed, and once the repository is free the same request
    // succeeds.
    assert!(f.worktree_path("session-1").is_dir());
    drop(held);
    let removed = f.call("workspaceGit.remove", remove).await.unwrap();
    assert_eq!(removed["removed"], true, "{removed}");
}

#[cfg(unix)]
#[tokio::test]
async fn a_fetch_leaves_the_repository_to_other_sessions_while_it_transfers() {
    let f = Fixture::slow("*' fetch '*", "1");
    f.prepare("session-1", "main").await;
    let job_id = f.start_prepare(f.prepare_params("session-2", "main")).await;
    let common = common_dir(&f.main_path());
    let mut seen = false;
    for _ in 0..300 {
        let job = f
            .call("workspaceGit.job", json!({ "jobId": job_id }))
            .await
            .unwrap();
        assert_eq!(job["state"], "running", "{job}");
        if job["phase"] == "fetching" {
            seen = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(seen, "the prepare never fetched");
    assert!(
        repo_lock::try_lock(&common).is_some(),
        "the fetch held the repository lock"
    );
    // Another session's removal is not stuck behind the network.
    let mut remove = f.session("session-1");
    remove["force"] = json!(false);
    let removed = tokio::time::timeout(
        Duration::from_millis(900),
        f.call("workspaceGit.remove", remove),
    )
    .await
    .expect("removal waited for the fetch")
    .unwrap();
    assert_eq!(removed["removed"], true, "{removed}");
    let (job, _phases) = f.wait(&job_id).await;
    assert_eq!(job["state"], "succeeded", "{job}");
    assert!(f.worktree_path("session-2").is_dir());
}
