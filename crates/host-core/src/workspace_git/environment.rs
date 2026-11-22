//! The environment a tool gets when it runs inside a registered worktree.
//!
//! `workspace/toolExecute` is unchanged on the wire. host-core looks the tool
//! root up in the worktree registry and, for a registered worktree only, adds
//! the worktree's variables, its roots, and the git proxy rewrite. Any other
//! root gets exactly what it got before: nothing.

use std::path::Path;

use serde_json::Value;

use super::layout::{validate_variable_name, Layout, Repository};

/// A network transfer slower than this many bytes per second ...
const LOW_SPEED_LIMIT_BYTES: u32 = 1;
/// ... for this many seconds is stalled. `pi-host`'s credential proxy gives
/// up on an idle upstream connection a little later, as a backstop.
const LOW_SPEED_TIME_SECS: u32 = 300;
use super::{registry, WorkspaceGitError};
use crate::db::Database;

/// The git configuration pairs that send a repository's traffic through the
/// credential proxy: `url.<proxy><owner>/<repo>.git.insteadOf`, once for the
/// repository's HTTPS URL (the one host-core clones, so it comes first) and
/// once for each SSH spelling of it, `git@github.com:<owner>/<repo>.git` and
/// `ssh://git@github.com/<owner>/<repo>.git`. A push that names the
/// repository over SSH is therefore held to the same work-branch rule
/// instead of reaching GitHub with the host user's own keys. The pairs are
/// scoped to that repository, so every other URL behaves as if there were no
/// proxy.
pub fn proxy_rewrites(proxy_url: &str, repository: &Repository) -> Vec<(String, String)> {
    let key = format!(
        "url.{proxy_url}{}/{}.git.insteadOf",
        repository.owner, repository.name
    );
    let path = format!("{}/{}.git", repository.owner, repository.name);
    [
        Layout::github_url(repository),
        format!("git@github.com:{path}"),
        format!("ssh://git@github.com/{path}"),
    ]
    .into_iter()
    .map(|url| (key.clone(), url))
    .collect()
}

/// The git configuration for traffic to GitHub from this host, as key and
/// value pairs for `GIT_CONFIG_COUNT`. host-run git and the Agent's Bash get
/// the same pairs:
///
/// - the proxy rewrites for the session's repository (`proxy_rewrites`);
/// - an empty `credential.helper` and `core.askPass`, so git neither asks the
///   host user's own helpers for a credential nor offers them one to store.
///   The only credential in play is the one the proxy adds;
/// - `http.lowSpeedLimit` and `http.lowSpeedTime`, so an HTTP transfer that
///   moves less than one byte per second for five minutes is abandoned
///   (`WORKSPACE_GIT_STALLED`) instead of holding its job until the overall
///   limit. GitHub's keepalive and progress packets keep a slow but live
///   transfer above it;
/// - an empty proxy for the credential proxy's own address, so loopback
///   traffic to it is never handed to a configured HTTP proxy.
///
/// Without a proxy address only the credential and low-speed pairs apply.
pub fn network_config(proxy_url: Option<&str>, repository: &Repository) -> Vec<(String, String)> {
    let mut config = Vec::with_capacity(8);
    if let Some(proxy_url) = proxy_url {
        config.extend(proxy_rewrites(proxy_url, repository));
    }
    config.push(("credential.helper".to_string(), String::new()));
    config.push(("core.askPass".to_string(), String::new()));
    config.push((
        "http.lowSpeedLimit".to_string(),
        LOW_SPEED_LIMIT_BYTES.to_string(),
    ));
    config.push((
        "http.lowSpeedTime".to_string(),
        LOW_SPEED_TIME_SECS.to_string(),
    ));
    if let Some(proxy_url) = proxy_url {
        config.push((format!("http.{proxy_url}.proxy"), String::new()));
    }
    config
}

/// Read an optional `gitProxyUrl` / `gitProxy.url` value. Only the shape
/// `pi-host` produces is accepted, `http://127.0.0.1:<port>/<64 hex>/`, so the
/// rewrite can never point git at another machine.
pub fn parse_proxy_url(value: Option<&Value>) -> Result<Option<String>, WorkspaceGitError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let invalid = || WorkspaceGitError::invalid("git proxy URL is not a loopback proxy URL");
    let url = value.as_str().ok_or_else(invalid)?;
    let rest = url.strip_prefix("http://127.0.0.1:").ok_or_else(invalid)?;
    let (port, handle) = rest
        .strip_suffix('/')
        .and_then(|rest| rest.split_once('/'))
        .ok_or_else(invalid)?;
    let port_ok = (1..=5).contains(&port.len())
        && port.bytes().all(|byte| byte.is_ascii_digit())
        && port.parse::<u16>().is_ok_and(|port| port != 0);
    let handle_ok = handle.len() == 64
        && handle
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    if port_ok && handle_ok {
        Ok(Some(url.to_string()))
    } else {
        Err(invalid())
    }
}

/// Environment for a tool rooted at `root`.
///
/// Inside a registered worktree, in order: the record's variables,
/// `PI_WORKTREE_ROOT`, `PI_PROJECT_ROOT` (the main checkout), and the Git
/// configuration. Without a live proxy URL the repository is rewritten to
/// a disabled transport. Other roots keep their existing environment.
pub fn for_tool(db: &Database, root: &Path, git_proxy_url: Option<&str>) -> Vec<(String, String)> {
    let record = match registry::find_by_path(db, root) {
        Ok(Some(record)) => record,
        Ok(None) => return Vec::new(),
        Err(error) => {
            tracing::warn!(%error, "could not read the workspace git registry");
            return Vec::new();
        }
    };
    let mut env: Vec<(String, String)> = record
        .variables
        .iter()
        // A name that is refused today may have been stored by an older build.
        .filter(|variable| validate_variable_name(&variable.name).is_ok())
        .map(|variable| (variable.name.clone(), variable.value.clone()))
        .collect();
    env.push(("PI_WORKTREE_ROOT".to_string(), record.path.clone()));
    env.push(("PI_PROJECT_ROOT".to_string(), record.main_path.clone()));
    if let Ok(repository) = record.repository.validated() {
        let proxy_url = git_proxy_url.unwrap_or("pi-workspace-no-credential:///");
        let mut config = network_config(Some(proxy_url), &repository);
        if git_proxy_url.is_none() {
            config.push((
                "protocol.pi-workspace-no-credential.allow".to_string(),
                "never".to_string(),
            ));
        }
        env.push(("GIT_ASKPASS".to_string(), String::new()));
        env.push(("GIT_TERMINAL_PROMPT".to_string(), "0".to_string()));
        env.push(("GIT_CONFIG_COUNT".to_string(), config.len().to_string()));
        for (index, (key, value)) in config.into_iter().enumerate() {
            env.push((format!("GIT_CONFIG_KEY_{index}"), key));
            env.push((format!("GIT_CONFIG_VALUE_{index}"), value));
        }
    }
    env
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_git::layout::Repository;
    use crate::workspace_git::registry::{self, SetupStatus, Variable, WorktreeRecord};

    const INSTALLATION: &str = "00000000-0000-4000-8000-000000000000";

    fn proxy() -> String {
        format!("http://127.0.0.1:4321/{}/", "ab".repeat(32))
    }

    fn database() -> (tempfile::TempDir, Database) {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        (dir, db)
    }

    fn register(db: &Database, path: &str, variables: &[(&str, &str)]) {
        registry::insert(
            db,
            &WorktreeRecord {
                installation_id: INSTALLATION.into(),
                session_id: "s-1".into(),
                repository: Repository::parse("octo", "repo.js").unwrap(),
                base_branch: "main".into(),
                work_branch: "pi-desktop/8b54618f6bc1".into(),
                path: path.into(),
                main_path: "/w/repos/github.com/octo/repo.js".into(),
                base_commit: "a".repeat(40),
                created_at: "2026-11-20T00:00:00.000Z".into(),
                variables: variables
                    .iter()
                    .map(|(name, value)| Variable {
                        name: name.to_string(),
                        value: value.to_string(),
                    })
                    .collect(),
                setup_script: None,
                setup_status: SetupStatus::None,
                setup_log_tail: None,
                recovery: Default::default(),
            },
        )
        .unwrap();
    }

    fn pairs(env: &[(String, String)]) -> Vec<(&str, &str)> {
        env.iter()
            .map(|(name, value)| (name.as_str(), value.as_str()))
            .collect()
    }

    #[test]
    fn a_registered_worktree_gets_its_variables_and_roots_in_order() {
        let (_dir, db) = database();
        let root = "/w/worktrees/github.com/octo/repo.js/8b54618f6bc1";
        register(&db, root, &[("MY_VAR", "one"), ("OTHER", "two words")]);
        let expected = [
            ("MY_VAR", "one"),
            ("OTHER", "two words"),
            ("PI_WORKTREE_ROOT", root),
            ("PI_PROJECT_ROOT", "/w/repos/github.com/octo/repo.js"),
        ];
        let env = for_tool(&db, Path::new(root), None);
        assert!(pairs(&env).starts_with(&expected));
        assert!(pairs(&env).contains(&(
            "GIT_CONFIG_KEY_8",
            "protocol.pi-workspace-no-credential.allow"
        )));
        assert!(pairs(&env).contains(&("GIT_CONFIG_VALUE_8", "never")));
        let nested = Path::new(root).join("packages/app");
        assert_eq!(for_tool(&db, &nested, None), env);
    }

    #[test]
    fn a_live_proxy_replaces_the_disabled_transport() {
        let (_dir, db) = database();
        let root = "/w/worktrees/github.com/octo/repo.js/8b54618f6bc1";
        register(&db, root, &[("MY_VAR", "one")]);
        let proxy = proxy();
        let env = for_tool(&db, Path::new(root), Some(&proxy));
        let key = format!("url.{proxy}octo/repo.js.git.insteadOf");
        let no_proxy = format!("http.{proxy}.proxy");
        assert_eq!(
            pairs(&env),
            [
                ("MY_VAR", "one"),
                ("PI_WORKTREE_ROOT", root),
                ("PI_PROJECT_ROOT", "/w/repos/github.com/octo/repo.js"),
                ("GIT_ASKPASS", ""),
                ("GIT_TERMINAL_PROMPT", "0"),
                ("GIT_CONFIG_COUNT", "8"),
                ("GIT_CONFIG_KEY_0", key.as_str()),
                ("GIT_CONFIG_VALUE_0", "https://github.com/octo/repo.js.git"),
                ("GIT_CONFIG_KEY_1", key.as_str()),
                ("GIT_CONFIG_VALUE_1", "git@github.com:octo/repo.js.git"),
                ("GIT_CONFIG_KEY_2", key.as_str()),
                (
                    "GIT_CONFIG_VALUE_2",
                    "ssh://git@github.com/octo/repo.js.git"
                ),
                ("GIT_CONFIG_KEY_3", "credential.helper"),
                ("GIT_CONFIG_VALUE_3", ""),
                ("GIT_CONFIG_KEY_4", "core.askPass"),
                ("GIT_CONFIG_VALUE_4", ""),
                ("GIT_CONFIG_KEY_5", "http.lowSpeedLimit"),
                ("GIT_CONFIG_VALUE_5", "1"),
                ("GIT_CONFIG_KEY_6", "http.lowSpeedTime"),
                ("GIT_CONFIG_VALUE_6", "300"),
                ("GIT_CONFIG_KEY_7", no_proxy.as_str()),
                ("GIT_CONFIG_VALUE_7", ""),
            ]
        );
        assert_eq!(
            proxy_rewrites(&proxy, &Repository::parse("octo", "repo.js").unwrap())[0],
            (
                key.clone(),
                "https://github.com/octo/repo.js.git".to_string()
            )
        );
    }

    #[test]
    fn network_git_ignores_the_host_users_credentials_and_http_proxy() {
        let proxy = proxy();
        let repository = Repository::parse("octo", "repo.js").unwrap();
        let config = network_config(Some(&proxy), &repository);
        let expected = [
            (
                format!("url.{proxy}octo/repo.js.git.insteadOf"),
                "https://github.com/octo/repo.js.git".to_string(),
            ),
            // The SSH spellings of the same repository, so the host user's
            // own keys never carry a push of it past the proxy.
            (
                format!("url.{proxy}octo/repo.js.git.insteadOf"),
                "git@github.com:octo/repo.js.git".to_string(),
            ),
            (
                format!("url.{proxy}octo/repo.js.git.insteadOf"),
                "ssh://git@github.com/octo/repo.js.git".to_string(),
            ),
            // An empty value resets the list: no helper of the host user is
            // asked for a credential, and none is offered a token to store.
            ("credential.helper".to_string(), String::new()),
            ("core.askPass".to_string(), String::new()),
            // A transfer that stops moving is abandoned instead of holding
            // the job until its overall limit.
            ("http.lowSpeedLimit".to_string(), "1".to_string()),
            ("http.lowSpeedTime".to_string(), "300".to_string()),
            // Loopback traffic to the credential proxy never goes through a
            // configured HTTP proxy.
            (format!("http.{proxy}.proxy"), String::new()),
        ];
        assert_eq!(config, expected);
        // Without a proxy address there is nothing to rewrite or exempt.
        assert_eq!(
            network_config(None, &repository),
            [
                ("credential.helper".to_string(), String::new()),
                ("core.askPass".to_string(), String::new()),
                ("http.lowSpeedLimit".to_string(), "1".to_string()),
                ("http.lowSpeedTime".to_string(), "300".to_string()),
            ]
        );
    }

    /// `git ls-remote <url>` with the session's network configuration, and
    /// `ssh` refused, so nothing leaves the machine.
    fn ls_remote(config: &[(String, String)], url: &str) -> String {
        let mut command = std::process::Command::new("git");
        for (name, _) in std::env::vars() {
            if name.starts_with("GIT_") {
                command.env_remove(name);
            }
        }
        command
            .args(["-c", "protocol.ssh.allow=never", "ls-remote", "--", url])
            .env("GIT_CONFIG_COUNT", config.len().to_string())
            .env("GIT_TERMINAL_PROMPT", "0");
        for (index, (key, value)) in config.iter().enumerate() {
            command
                .env(format!("GIT_CONFIG_KEY_{index}"), key)
                .env(format!("GIT_CONFIG_VALUE_{index}"), value);
        }
        let output = command.output().unwrap();
        assert!(!output.status.success());
        String::from_utf8_lossy(&output.stderr).into_owned()
    }

    #[test]
    fn every_spelling_of_the_session_repository_goes_through_the_proxy() {
        let repository = Repository::parse("octo", "repo.js").unwrap();
        let mut config = network_config(Some("pi-workspace-no-credential:///"), &repository);
        config.push((
            "protocol.pi-workspace-no-credential.allow".to_string(),
            "never".to_string(),
        ));
        // The host user's own SSH keys never see the session's repository:
        // all three spellings land on the (here disabled) proxy transport.
        for url in [
            "https://github.com/octo/repo.js.git",
            "git@github.com:octo/repo.js.git",
            "ssh://git@github.com/octo/repo.js.git",
        ] {
            let stderr = ls_remote(&config, url);
            assert!(
                stderr.contains("transport 'pi-workspace-no-credential' not allowed"),
                "{url}: {stderr}"
            );
        }
        // Any other repository is left alone, as if there were no proxy.
        for url in [
            "git@github.com:octo/other.git",
            "ssh://git@github.com/elsewhere/repo.js.git",
        ] {
            let stderr = ls_remote(&config, url);
            assert!(
                stderr.contains("transport 'ssh' not allowed"),
                "{url}: {stderr}"
            );
        }
    }

    #[test]
    fn any_other_root_gets_nothing_whatever_the_proxy_says() {
        let (_dir, db) = database();
        register(
            &db,
            "/w/worktrees/github.com/octo/repo.js/abc",
            &[("MY_VAR", "one")],
        );
        let proxy = proxy();
        for root in [
            "/w/worktrees/github.com/octo/repo.js/abcd",
            "/w/worktrees/github.com/octo/repo.js",
            "/w/repos/github.com/octo/repo.js",
            "/home/user/project",
        ] {
            assert!(
                for_tool(&db, Path::new(root), Some(&proxy)).is_empty(),
                "{root}"
            );
            assert!(for_tool(&db, Path::new(root), None).is_empty(), "{root}");
        }
    }

    #[test]
    fn a_stored_variable_with_a_forbidden_name_is_skipped() {
        let (_dir, db) = database();
        let root = "/w/worktrees/github.com/octo/repo.js/abc";
        // Stored by an older build, or written into the database by hand.
        register(
            &db,
            root,
            &[
                ("GIT_DIR", "/elsewhere"),
                ("KEEP", "yes"),
                ("LD_PRELOAD", "/tmp/x.so"),
                ("PI_WORKTREE_ROOT", "/elsewhere"),
                ("PATH", "/tmp"),
                ("A=B", "x"),
            ],
        );
        let env = for_tool(&db, Path::new(root), None);
        assert!(pairs(&env).starts_with(&[
            ("KEEP", "yes"),
            ("PI_WORKTREE_ROOT", root),
            ("PI_PROJECT_ROOT", "/w/repos/github.com/octo/repo.js"),
        ]));
    }

    #[test]
    fn only_a_loopback_proxy_url_with_a_handle_is_accepted() {
        let good = proxy();
        assert_eq!(
            parse_proxy_url(Some(&serde_json::json!(good))).unwrap(),
            Some(good.clone())
        );
        assert_eq!(parse_proxy_url(None).unwrap(), None);
        for bad in [
            serde_json::json!(""),
            serde_json::json!(1),
            serde_json::json!(null),
            serde_json::json!("https://github.com/"),
            serde_json::json!(format!("http://evil.example:80/{}/", "ab".repeat(32))),
            serde_json::json!(format!(
                "http://127.0.0.1.evil.example/{}/",
                "ab".repeat(32)
            )),
            serde_json::json!(format!("http://127.0.0.1:4321/{}", "ab".repeat(32))),
            serde_json::json!(format!("http://127.0.0.1:4321/{}/extra/", "ab".repeat(32))),
            serde_json::json!(format!("http://127.0.0.1:/{}/", "ab".repeat(32))),
            serde_json::json!(format!("http://127.0.0.1:999999/{}/", "ab".repeat(32))),
            serde_json::json!("http://127.0.0.1:4321/short/"),
            serde_json::json!(format!("http://127.0.0.1:4321/{}/\n", "ab".repeat(32))),
            serde_json::json!(format!("http://user@127.0.0.1:4321/{}/", "ab".repeat(32))),
        ] {
            let error = parse_proxy_url(Some(&bad)).unwrap_err();
            assert_eq!(error.code, "INVALID_ARGUMENT", "{bad}");
        }
    }
}
