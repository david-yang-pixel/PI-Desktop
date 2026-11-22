//! A work branch that no registration owns, left by an older host-core that
//! created branches without registering them first. It may hold the only copy
//! of the session's work: a prepare adopts it as it is, and never deletes or
//! resets it.

use std::fs;

use super::*;

/// Leave `refs/heads/<work branch of session>` at `commit`, with no record.
fn orphan_branch(f: &Fixture, session: &str, commit: &str) -> String {
    let branch = work_branch(INSTALLATION, session);
    git_cmd(&f.main_path(), &["branch", "--", &branch, commit]);
    branch
}

fn branch_head(f: &Fixture, branch: &str) -> String {
    rev_parse(&f.main_path(), &format!("refs/heads/{branch}"))
}

#[tokio::test]
async fn a_prepare_adopts_an_unregistered_work_branch_with_its_commits() {
    let f = Fixture::new();
    f.prepare("session-1", "main").await;
    // The older build's branch carries a commit no remote branch has.
    let develop = rev_parse(&f.main_path(), "refs/remotes/origin/develop");
    let branch = orphan_branch(&f, "session-2", &develop);
    let path = f.worktree_path("session-2");

    let worktree = f.prepare("session-2", "main").await;
    assert_eq!(worktree["workBranch"], branch);
    assert_eq!(worktree["checkoutPresent"], true);
    // Checked out as it was: nothing deleted, reset, or rebased.
    assert_eq!(branch_head(&f, &branch), develop);
    assert_eq!(rev_parse(&path, "HEAD"), develop);
    assert_eq!(
        git_cmd(&path, &["symbolic-ref", "--short", "HEAD"]).trim(),
        branch
    );
    assert!(path.join("develop.txt").is_file());
    // The base commit is where the branch left the base branch.
    let base = git_cmd(
        &f.main_path(),
        &["merge-base", "refs/remotes/origin/main", &develop],
    );
    assert_eq!(worktree["baseCommit"], base.trim());
    // From now on it is the session's branch, protected like any other.
    let status = f
        .call("workspaceGit.status", f.session("session-2"))
        .await
        .unwrap();
    assert_eq!(status["unpushedCommits"], 0, "develop is on the remote");
    commit_file(&path, "more.txt", "more\n");
    let refused = f
        .call("workspaceGit.removeSafely", f.session("session-2"))
        .await
        .unwrap();
    assert_eq!(refused["removed"], false, "{refused}");
    assert_eq!(refused["unpushedCommits"], 1);
}

#[tokio::test]
async fn a_foreign_directory_stops_the_adoption_and_both_survive() {
    let f = Fixture::new();
    f.prepare("session-1", "main").await;
    let head = rev_parse(&f.main_path(), "refs/remotes/origin/main");
    let branch = orphan_branch(&f, "session-2", &head);
    let path = f.worktree_path("session-2");
    fs::create_dir_all(&path).unwrap();
    fs::write(path.join("mine.txt"), "not git's").unwrap();
    let job_id = f.start_prepare(f.prepare_params("session-2", "main")).await;
    let (job, _phases) = f.wait(&job_id).await;
    assert_eq!(job["state"], "failed", "{job}");
    assert_eq!(
        fs::read_to_string(path.join("mine.txt")).unwrap(),
        "not git's"
    );
    assert_eq!(branch_head(&f, &branch), head);
    let listed = f
        .call(
            "workspaceGit.list",
            json!({ "installationId": INSTALLATION }),
        )
        .await
        .unwrap();
    assert_eq!(listed["worktrees"].as_array().unwrap().len(), 1);
}

#[cfg(unix)]
#[tokio::test]
async fn a_cancelled_setup_after_an_adoption_keeps_the_branch() {
    let f = Fixture::new();
    f.prepare("session-1", "main").await;
    let develop = rev_parse(&f.main_path(), "refs/remotes/origin/develop");
    let branch = orphan_branch(&f, "session-2", &develop);
    let mut params = f.prepare_params("session-2", "main");
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
        assert_eq!(job["state"], "running", "{job}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    f.call("workspaceGit.jobCancel", json!({ "jobId": job_id }))
        .await
        .unwrap();
    let (job, _phases) = f.wait(&job_id).await;
    assert_eq!(job["state"], "cancelled", "{job}");
    // The branch was not this prepare's to discard.
    assert_eq!(branch_head(&f, &branch), develop);
}

#[cfg(unix)]
#[tokio::test]
async fn an_adoption_that_fails_keeps_the_branch_registered_and_a_retry_finishes_it() {
    use std::os::unix::fs::PermissionsExt;
    // A git whose `worktree add` fails while the marker exists.
    let f = Fixture::with_git(|base| {
        let marker = base.join("inject-failure");
        let script = base.join("failing-git");
        fs::write(
            &script,
            format!(
                "#!/bin/sh\nif [ -e '{}' ]; then case \" $* \" in *' worktree add '*) echo injected failure >&2; exit 1;; esac; fi\nexec git \"$@\"\n",
                marker.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        GitRunner::with_program(script)
    });
    f.prepare("session-1", "main").await;
    let develop = rev_parse(&f.main_path(), "refs/remotes/origin/develop");
    let branch = orphan_branch(&f, "session-2", &develop);
    let marker = crate::workspace::simple_canonicalize(f.dir.path())
        .unwrap()
        .join("inject-failure");
    fs::write(&marker, "").unwrap();
    let job_id = f.start_prepare(f.prepare_params("session-2", "main")).await;
    let (job, _phases) = f.wait(&job_id).await;
    assert_eq!(job["state"], "failed", "{job}");
    assert_eq!(branch_head(&f, &branch), develop);
    assert!(!f.worktree_path("session-2").exists());
    // The registration owns the branch now: it is listed without a checkout,
    // and removal counts its work.
    let status = f
        .call("workspaceGit.status", f.session("session-2"))
        .await
        .unwrap();
    assert_eq!(status["worktree"]["checkoutPresent"], false, "{status}");
    fs::remove_file(&marker).unwrap();
    let worktree = f.prepare("session-2", "main").await;
    assert_eq!(worktree["checkoutPresent"], true);
    assert_eq!(rev_parse(&f.worktree_path("session-2"), "HEAD"), develop);
    assert_eq!(branch_head(&f, &branch), develop);
}
