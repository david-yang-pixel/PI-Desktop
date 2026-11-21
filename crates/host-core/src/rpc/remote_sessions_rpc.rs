use super::*;
use crate::db::{Database, RemoteWorkspace};
use crate::remote_sessions::{self, bindings, environments};
use crate::workspace_git::layout::Repository;
use serde::de::DeserializeOwned;

fn parse<T: DeserializeOwned>(value: Value) -> Result<T, JsonRpcError> {
    serde_json::from_value(value).map_err(invalid)
}

fn invalid(error: impl ToString) -> JsonRpcError {
    rpc_err(1002, error.to_string(), "INVALID_ARGUMENT")
}

fn field<'a>(params: &'a Value, key: &str) -> Result<&'a str, JsonRpcError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(format!("{key} is required")))
}

pub(super) fn handle(db: &Database, method: &str, params: Value) -> Result<Value, JsonRpcError> {
    match method {
        "environments.list" => {
            Ok(json!({ "environments": environments::list(db).map_err(invalid)? }))
        }
        "environments.upsert" => {
            Ok(json!({ "environment": environments::upsert(db, parse(params)?).map_err(invalid)? }))
        }
        "environments.remove" => {
            if !environments::remove(db, field(&params, "id")?).map_err(invalid)? {
                return Err(rpc_err(
                    1007,
                    "environment not found",
                    "REMOTE_ENVIRONMENT_NOT_FOUND",
                ));
            }
            Ok(json!({ "ok": true }))
        }
        "environments.removeForHost" => Ok(
            json!({ "removed": environments::remove_for_host(db, field(&params, "hostKey")?).map_err(invalid)? }),
        ),
        "project.group.ensureRepository" => {
            let remote = RemoteWorkspace {
                host_key: field(&params, "hostKey")?.into(),
                path: field(&params, "path")?.into(),
            };
            let repository = parse::<Repository>(params["repository"].clone())?
                .validated()
                .map_err(invalid)?;
            let (group, created) = remote_sessions::ensure_repository(
                db,
                remote,
                repository,
                field(&params, "defaultBranch")?.into(),
            )
            .map_err(invalid)?;
            Ok(json!({ "group": group, "created": created }))
        }
        "sessionWorkspace.bind" => {
            Ok(json!({ "binding": bindings::bind(db, parse(params)?).map_err(invalid)? }))
        }
        "sessionWorkspace.update" => {
            let patch = params["patch"]
                .as_object()
                .ok_or_else(|| invalid("patch is required"))?;
            let expected = params
                .get("expectedState")
                .map(|value| parse(value.clone()))
                .transpose()?;
            let binding = bindings::update(db, field(&params, "sessionId")?, patch, expected)
                .map_err(invalid)?
                .ok_or_else(|| rpc_err(1008, "workspace binding state changed", "CONFLICT"))?;
            Ok(json!({ "binding": binding }))
        }
        "sessionWorkspace.touchActivity" => {
            let touched =
                bindings::touch_activity(db, field(&params, "sessionId")?).map_err(invalid)?;
            Ok(json!({ "ok": true, "touched": touched }))
        }
        "sessionWorkspace.get" => Ok(
            json!({ "binding": bindings::get(db, field(&params, "sessionId")?).map_err(invalid)? }),
        ),
        "sessionWorkspace.list" => {
            let states: Vec<bindings::State> = params
                .get("states")
                .map(|value| parse(value.clone()))
                .transpose()?
                .unwrap_or_default();
            Ok(json!({ "bindings": bindings::list(db, &states).map_err(invalid)? }))
        }
        "sessionWorkspace.remove" => {
            bindings::remove(db, field(&params, "sessionId")?).map_err(invalid)?;
            Ok(json!({ "ok": true }))
        }
        "sessionWorkspace.pendingRemoval.add" => {
            bindings::add_pending(db, parse(params)?).map_err(invalid)?;
            Ok(json!({ "ok": true }))
        }
        "sessionWorkspace.pendingRemoval.list" => Ok(
            json!({ "removals": bindings::pending(db, params.get("hostKey").and_then(Value::as_str)).map_err(invalid)? }),
        ),
        "sessionWorkspace.pendingRemoval.remove" => {
            bindings::remove_pending(db, field(&params, "hostKey")?, field(&params, "sessionId")?)
                .map_err(invalid)?;
            Ok(json!({ "ok": true }))
        }
        _ => Err(rpc_err(-32601, "method not found", "METHOD_NOT_FOUND")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_state_compare_and_swap_preserves_legacy_activity_until_touch() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        let old_timestamp = "2026-01-01T00:00:00.000Z";
        let original = json!({
            "sessionId": "s", "environmentId": "default:remote", "hostKey": "remote",
            "repository": { "owner": "octo", "name": "repo" }, "baseBranch": "main",
            "state": "ready", "path": "/workspace/test", "workBranch": "pi-desktop/test",
            "createdAt": old_timestamp, "updatedAt": old_timestamp,
        });
        db.kv_set("sessionWorkspaces", "s", &original).unwrap();
        let error = handle(
            &db,
            "sessionWorkspace.update",
            json!({
                "sessionId": "s", "expectedState": "preparing", "patch": {"state": "removing"},
            }),
        )
        .unwrap_err();
        assert_eq!(error.data.unwrap()["errorCode"], "CONFLICT");
        assert_eq!(db.kv_get("sessionWorkspaces", "s").unwrap(), Some(original));

        let changed = handle(
            &db,
            "sessionWorkspace.update",
            json!({
                "sessionId": "s", "patch": {"pullRequest": {"number": 1}},
            }),
        )
        .unwrap();
        assert_eq!(changed["binding"]["lastActivityAt"], old_timestamp);
        assert_ne!(changed["binding"]["updatedAt"], old_timestamp);
        let touched = handle(
            &db,
            "sessionWorkspace.touchActivity",
            json!({"sessionId": "s"}),
        )
        .unwrap();
        assert_eq!(touched["touched"], true);
        let read = handle(&db, "sessionWorkspace.get", json!({"sessionId": "s"})).unwrap();
        let touched_at = &read["binding"]["lastActivityAt"];
        assert_ne!(touched_at, old_timestamp);

        let changed = handle(
            &db,
            "sessionWorkspace.update",
            json!({
                "sessionId": "s", "expectedState": "ready", "patch": {"state": "reclaiming"},
            }),
        )
        .unwrap();
        assert_eq!(changed["binding"]["state"], "reclaiming");
        assert_eq!(changed["binding"]["lastActivityAt"], *touched_at);
        let touched = handle(
            &db,
            "sessionWorkspace.touchActivity",
            json!({"sessionId": "s"}),
        )
        .unwrap();
        assert_eq!(touched["touched"], false);
        let read = handle(&db, "sessionWorkspace.get", json!({"sessionId": "s"})).unwrap();
        assert_eq!(read, changed);
    }

    #[test]
    fn environments_default_idle_reclaim_fields_and_validate_updates() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        let input = json!({"id": "default:remote", "hostKey": "remote", "name": "Default"});
        db.kv_set(
            "remoteEnvironments",
            "default:remote",
            &json!({
                "id": "default:remote", "hostKey": "remote", "name": "Default", "setupScript": "",
                "variables": [], "createdAt": "old", "updatedAt": "old",
            }),
        )
        .unwrap();
        let listed = handle(&db, "environments.list", json!({})).unwrap();
        assert_eq!(listed["environments"][0]["idleReclaimHours"], 72);
        assert_eq!(listed["environments"][0]["regenerableDirs"], json!([]));
        let mut change = input.clone();
        change["idleReclaimHours"] = json!(0);
        change["regenerableDirs"] = json!(["apps/web/dist"]);
        handle(&db, "environments.upsert", change).unwrap();
        let saved = handle(&db, "environments.upsert", input.clone()).unwrap();
        assert_eq!(saved["environment"]["idleReclaimHours"], 0);
        assert_eq!(
            saved["environment"]["regenerableDirs"],
            json!(["apps/web/dist"])
        );
        for value in [
            json!(["../outside"]),
            json!(["/absolute"]),
            json!(["a/.git/b"]),
        ] {
            let mut invalid = input.clone();
            invalid["regenerableDirs"] = value;
            assert!(handle(&db, "environments.upsert", invalid).is_err());
        }
    }
}
