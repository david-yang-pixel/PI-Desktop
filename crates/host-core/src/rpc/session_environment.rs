//! Session-scoped configuration for paired environments without a repository.
use super::{command_shell_catalog, rpc_err, AppState, JsonRpcError};
use crate::db::Database;
use crate::remote_sessions::environments::validate_variables;
use crate::session_worktrees::lifecycle::SharedState;
use crate::workspace_git::{registry::Variable, setup};
use serde_json::{json, Value};
use std::path::Path;

const NS: &str = "sessionEnvironmentVariables";

pub(super) struct Environment {
    pub variables: Vec<Variable>,
    pub setup_script: String,
}

fn invalid() -> JsonRpcError {
    rpc_err(1002, "invalid workspace environment", "INVALID_PARAMS")
}

fn storage_error(error: anyhow::Error) -> JsonRpcError {
    rpc_err(1000, error.to_string(), "INTERNAL")
}

pub(super) fn variables(value: Value) -> Result<Vec<Variable>, JsonRpcError> {
    let variables: Vec<Variable> = serde_json::from_value(value).map_err(|_| invalid())?;
    validate_variables(&variables).map_err(|_| invalid())?;
    Ok(variables)
}

pub(super) fn parse(value: Value) -> Result<Environment, JsonRpcError> {
    let Value::Object(mut input) = value else {
        return Err(invalid());
    };
    let vars = variables(input.remove("variables").ok_or_else(invalid)?)?;
    let script = input.remove("setupScript");
    if !input.is_empty() {
        return Err(invalid());
    }
    let setup_script = match script {
        None => String::new(),
        Some(Value::String(script))
            if script.chars().count() <= 65_536 && !script.contains('\0') =>
        {
            script
        }
        Some(_) => return Err(invalid()),
    };
    Ok(Environment {
        variables: vars,
        setup_script,
    })
}

pub(super) fn save(db: &Database, session_id: &str, vars: &[Variable]) -> Result<(), JsonRpcError> {
    if !vars.is_empty() {
        db.kv_set(NS, session_id, &json!(vars))
            .map_err(storage_error)?;
    }
    Ok(())
}

pub(super) fn load(db: &Database, session_id: &str) -> Result<Vec<Variable>, JsonRpcError> {
    db.kv_get(NS, session_id)
        .map_err(storage_error)?
        .map(variables)
        .transpose()
        .map(Option::unwrap_or_default)
}

pub(super) fn clear(db: &Database, session_id: &str) {
    if let Err(error) = db.kv_delete(NS, session_id) {
        tracing::warn!(%error, "could not delete session environment variables");
    }
}

pub(super) fn pairs(vars: Vec<Variable>) -> impl Iterator<Item = (String, String)> {
    vars.into_iter().map(|var| (var.name, var.value))
}

pub(super) fn shell(state: &AppState) -> Result<String, JsonRpcError> {
    command_shell_catalog(state)?
        .effective
        .map(|shell| shell.id)
        .ok_or_else(|| rpc_err(1002, "command shell unavailable", "SHELL_NOT_FOUND"))
}

pub(super) async fn run(root: &Path, scope: &str, shell_id: String, input: Environment) -> Value {
    let (_cancel, cancellation) = tokio::sync::watch::channel(false);
    let (status, log_tail) = setup::run(setup::SetupRun {
        root,
        script: &input.setup_script,
        shell_id,
        env: pairs(input.variables).collect(),
        session_id: scope,
        short_id: scope,
        cancellation,
        on_output: None,
    })
    .await;
    json!({ "status": status, "logTail": log_tail })
}

pub(super) async fn setup_folder(state: SharedState, params: Value) -> Result<Value, JsonRpcError> {
    let path = params
        .get("path")
        .and_then(Value::as_str)
        .filter(|path| Path::new(path).is_absolute())
        .ok_or_else(invalid)?;
    let root = std::fs::canonicalize(path).map_err(|_| invalid())?;
    if !root.is_dir() {
        return Err(invalid());
    }
    let input = parse(params.get("environment").cloned().ok_or_else(invalid)?)?;
    let shell_id = {
        let st = state.lock().await;
        if crate::workspace_git::registry::find_by_path(&st.db, &root)
            .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?
            .is_some()
        {
            return Err(invalid());
        }
        shell(&st)?
    };
    let scope = uuid::Uuid::new_v4().to_string();
    Ok(run(&root, &scope, shell_id, input).await)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::rpc::handle_request;
    use crate::sessions;
    use std::sync::Arc;
    use tokio::sync::{mpsc, Mutex};

    #[tokio::test]
    async fn temporary_session_runs_setup_then_exposes_only_its_saved_variables() {
        let data = tempfile::tempdir().unwrap();
        let mut app = AppState::open(data.path()).unwrap();
        app.handshook = true;
        let state = Arc::new(Mutex::new(app));
        let (tx, _rx) = mpsc::unbounded_channel();
        let created = handle_request(
            state.clone(),
            "session.create",
            json!({
                "environment": {
                    "setupScript": "printf '%s' \"$FIXTURE_SETUP_VALUE\" > setup.txt",
                    "variables": [{ "name": "FIXTURE_SETUP_VALUE", "value": "configured" }],
                },
            }),
            tx.clone(),
        )
        .await
        .unwrap();
        let id = created["session"]["id"].as_str().unwrap();
        let path = crate::scratch::session_dir(data.path(), id).unwrap();
        assert_eq!(created["setup"]["status"], "ok", "{created}");
        assert_eq!(
            std::fs::read_to_string(path.join("setup.txt")).unwrap(),
            "configured"
        );
        let (shell_id, other_id) = {
            let st = state.lock().await;
            sessions::configure_session_with_thinking(
                &st.db,
                id,
                "agent",
                None,
                None,
                None,
                Some("auto"),
            )
            .unwrap();
            let other =
                sessions::create_session(&st.db, None, Some("agent".into()), None, None, None)
                    .unwrap();
            sessions::configure_session_with_thinking(
                &st.db,
                &other.id,
                "agent",
                None,
                None,
                None,
                Some("auto"),
            )
            .unwrap();
            (shell(&st).unwrap(), other.id)
        };
        for (id, expected) in [(id, "configured"), (other_id.as_str(), "absent")] {
            let result = handle_request(
                state.clone(),
                "tools.execute",
                json!({
                    "sessionId": id,
                    "toolCallId": "probe",
                    "toolName": "Bash",
                    "mode": "agent",
                    "expectedCommandShellId": shell_id,
                    "expectedCommandShellDialect": crate::tools::shell::dialect_for_id(&shell_id),
                    "args": { "command": "printf '%s' \"${FIXTURE_SETUP_VALUE:-absent}\"" },
                }),
                tx.clone(),
            )
            .await
            .unwrap();
            assert_eq!(result["ok"], true, "{result}");
            assert_eq!(result["content"]["stdout"], expected, "{result}");
        }
        handle_request(
            state.clone(),
            "session.delete",
            json!({"id": id}),
            tx.clone(),
        )
        .await
        .unwrap();
        assert!(load(&state.lock().await.db, id).unwrap().is_empty());
    }

    #[tokio::test]
    async fn folder_setup_reports_failure_and_rejects_reserved_variables() {
        let data = tempfile::tempdir().unwrap();
        let folder = tempfile::tempdir().unwrap();
        let state = Arc::new(Mutex::new(AppState::open(data.path()).unwrap()));
        let result = setup_folder(
            state.clone(),
            json!({
                "path": folder.path(),
                "environment": { "setupScript": "printf '%s' \"$FIXTURE_SETUP_VALUE\"; exit 7",
                    "variables": [{ "name": "FIXTURE_SETUP_VALUE", "value": "visible-failure" }] },
            }),
        )
        .await
        .unwrap();
        assert_eq!(result["status"], "failed");
        assert!(result["logTail"]
            .as_str()
            .unwrap()
            .contains("visible-failure"));
        for variables in [
            json!([{ "name": "BASH_ENV", "value": "/tmp/config" }]),
            json!([{ "name": "SETTING", "value": "one" }, { "name": "SETTING", "value": "two" }]),
        ] {
            assert!(setup_folder(state.clone(), json!({
                "path": folder.path(), "environment": { "variables": variables, "setupScript": "touch invalid.txt" },
            })).await.is_err());
        }
        assert!(!folder.path().join("invalid.txt").exists());
    }
}
