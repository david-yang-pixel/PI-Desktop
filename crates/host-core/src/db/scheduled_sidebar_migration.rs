use super::{create_migration_backup, Connection, Context, Path, Result};

pub(super) fn migrate(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 33)?;
    let tx = conn.unchecked_transaction()?;
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('task_runs') WHERE name = 'show_in_sidebar')",
        [],
        |row| row.get(0),
    )?;
    if !exists {
        tx.execute_batch(
            "ALTER TABLE task_runs ADD COLUMN show_in_sidebar INTEGER NOT NULL DEFAULT 0
             CHECK (show_in_sidebar IN (0, 1));",
        )?;
    }
    tx.pragma_update(None, "user_version", 34i64)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v33 to v34 scheduled sidebar migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::{migration_backup_path, Database, SCHEMA_VERSION};
    use crate::{scheduled, sessions};
    use serde_json::json;

    #[test]
    fn v33_run_history_keeps_its_session_and_stays_hidden() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        let (task_id, session_id) = {
            let db = Database::open(&path).unwrap();
            let task = scheduled::create_task(&db, &json!({"prompt": "Review"})).unwrap();
            let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
            let run = scheduled::begin_run(&db, &task, Some(&session.id)).unwrap();
            scheduled::finish_run(&db, &run, "completed", None).unwrap();
            db.conn()
                .execute_batch(
                    "ALTER TABLE task_runs DROP COLUMN show_in_sidebar; PRAGMA user_version = 33;",
                )
                .unwrap();
            (task.id, session.id)
        };

        let db = Database::open(&path).unwrap();
        assert!(migration_backup_path(&path, 33).is_file());
        let version: i64 = db
            .conn()
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        let runs = scheduled::list_runs(&db, Some(&task_id), 10).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].status, "completed");
        assert_eq!(runs[0].session_id.as_deref(), Some(session_id.as_str()));
        let session = sessions::get_session(&db, &session_id).unwrap().unwrap();
        assert!(session.summary.scheduled_run);
        assert!(!session.summary.show_scheduled_run_in_sidebar);
    }
}
