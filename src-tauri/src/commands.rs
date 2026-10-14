//! Tauri commands of the app (the SQL plugin brings its own load/execute/select).

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::SqlitePool;
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_sql::{DbInstances, DbPool};

/// One statement of a batch: SQL with `?` placeholders and its values.
#[derive(Debug, Deserialize)]
pub struct Statement {
    pub sql: String,
    #[serde(default)]
    pub params: Vec<Value>,
}

/// Runs `statements` in one transaction on the pool tauri-plugin-sql opened for `db`
/// (the exact string given to `Database.load`). All or nothing: the first error rolls back.
///
/// Needed because the plugin's own `execute` runs each call on any connection of an sqlx
/// pool (tauri-plugin-sql 2.5.0 wrapper.rs:176), so BEGIN/COMMIT sent as separate calls do
/// not form a transaction. The pool is reached through the plugin's managed `DbInstances`.
#[tauri::command]
pub async fn db_batch(
    instances: State<'_, DbInstances>,
    db: String,
    statements: Vec<Statement>,
) -> Result<(), String> {
    let pools = instances.0.read().await;
    match pools.get(&db) {
        Some(DbPool::Sqlite(pool)) => run_batch(pool, &statements).await,
        None => Err(format!("database {db} is not loaded")),
    }
}

/// Outcome of the startup backup (Ruling R21), managed as app state and read by the
/// frontend with `invoke('backup_status')`. `ok` with `path: None` means no copy was needed.
/// `at` is the Unix time (seconds) of the attempt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BackupStatus {
    pub ok: bool,
    pub path: Option<String>,
    pub error: Option<String>,
    pub at: u64,
}

impl BackupStatus {
    pub fn from_result(result: Result<Option<PathBuf>, String>, at: u64) -> Self {
        match result {
            Ok(path) => Self {
                ok: true,
                path: path.map(|p| p.to_string_lossy().into_owned()),
                error: None,
                at,
            },
            Err(e) => Self {
                ok: false,
                path: None,
                error: Some(e),
                at,
            },
        }
    }
}

/// Result of the backup made when the app started.
#[tauri::command]
pub fn backup_status(status: State<'_, BackupStatus>) -> BackupStatus {
    status.inner().clone()
}

/// Writes an export file into the user's Downloads folder and returns its full path.
/// `name` must be a plain file name (no separators, drive colon or "..").
#[tauri::command]
pub async fn export_file<R: Runtime>(
    app: AppHandle<R>,
    name: String,
    contents: String,
) -> Result<String, String> {
    let dir = app.path().download_dir().map_err(|e| e.to_string())?;
    backup::write_export(&dir, &name, &contents)
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}

pub(crate) async fn run_batch(pool: &SqlitePool, statements: &[Statement]) -> Result<(), String> {
    if statements.is_empty() {
        return Ok(());
    }
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    let mut result = Ok(());
    for (i, st) in statements.iter().enumerate() {
        result = execute_one(&mut tx, st)
            .await
            .map_err(|e| format!("statement {i}: {e}"));
        if result.is_err() {
            break;
        }
    }
    match result {
        Ok(()) => tx.commit().await.map_err(|e| e.to_string()),
        Err(e) => {
            // Explicit rollback; dropping the transaction would also roll back, but later.
            let _ = tx.rollback().await;
            Err(e)
        }
    }
}

async fn execute_one(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    st: &Statement,
) -> Result<(), String> {
    let mut q = sqlx::query(&st.sql);
    for v in &st.params {
        q = match v {
            Value::Null => q.bind(None::<i64>),
            Value::Bool(b) => q.bind(i64::from(*b)),
            Value::Number(n) => match n.as_i64() {
                Some(i) => q.bind(i),
                None => q.bind(n.as_f64().ok_or("number out of range")?),
            },
            Value::String(s) => q.bind(s.clone()),
            other => return Err(format!("unsupported parameter {other}")),
        };
    }
    q.execute(&mut **tx)
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::Row;

    fn st(sql: &str, params: Vec<Value>) -> Statement {
        Statement {
            sql: sql.into(),
            params,
        }
    }

    async fn pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE t (id TEXT PRIMARY KEY, i INTEGER, r REAL, b INTEGER, n TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        pool
    }

    async fn count(pool: &SqlitePool) -> i64 {
        sqlx::query("SELECT COUNT(*) AS c FROM t")
            .fetch_one(pool)
            .await
            .unwrap()
            .get("c")
    }

    #[test]
    fn commits_all_statements_with_typed_params() {
        tauri::async_runtime::block_on(async {
            let pool = pool().await;
            let insert = "INSERT INTO t (id, i, r, b, n) VALUES (?, ?, ?, ?, ?)";
            run_batch(
                &pool,
                &[
                    st(
                        insert,
                        vec![
                            json!("a"),
                            json!(4_000_000_000_i64),
                            json!(1.5),
                            json!(true),
                            json!(null),
                        ],
                    ),
                    st(
                        insert,
                        vec![
                            json!("b"),
                            json!(-3),
                            json!(2),
                            json!(false),
                            json!("x;\"y\""),
                        ],
                    ),
                ],
            )
            .await
            .unwrap();
            let row = sqlx::query("SELECT i, r, b, n FROM t WHERE id = 'a'")
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(row.get::<i64, _>("i"), 4_000_000_000);
            assert_eq!(row.get::<f64, _>("r"), 1.5);
            assert_eq!(row.get::<i64, _>("b"), 1);
            assert_eq!(row.get::<Option<String>, _>("n"), None);
            assert_eq!(count(&pool).await, 2);
        });
    }

    #[test]
    fn rolls_back_everything_on_error() {
        tauri::async_runtime::block_on(async {
            let pool = pool().await;
            let insert = "INSERT INTO t (id) VALUES (?)";
            let err = run_batch(
                &pool,
                &[
                    st(insert, vec![json!("a")]),
                    st(insert, vec![json!("b")]),
                    st(insert, vec![json!("a")]),
                ],
            )
            .await
            .unwrap_err();
            assert!(err.starts_with("statement 2:"), "{err}");
            assert_eq!(count(&pool).await, 0);
            // The single pooled connection is clean afterwards.
            run_batch(&pool, &[st(insert, vec![json!("c")])])
                .await
                .unwrap();
            assert_eq!(count(&pool).await, 1);
        });
    }

    #[test]
    fn rejects_unsupported_params_and_writes_nothing() {
        tauri::async_runtime::block_on(async {
            let pool = pool().await;
            let insert = "INSERT INTO t (id, n) VALUES (?, ?)";
            let err = run_batch(
                &pool,
                &[
                    st(insert, vec![json!("a"), json!("ok")]),
                    st(insert, vec![json!("b"), json!([1])]),
                ],
            )
            .await
            .unwrap_err();
            assert!(err.contains("unsupported parameter"), "{err}");
            assert_eq!(count(&pool).await, 0);
        });
    }

    #[test]
    fn backup_status_from_result() {
        let copy = PathBuf::from("backups").join("trainer-5.db");
        assert_eq!(
            BackupStatus::from_result(Ok(Some(copy.clone())), 5),
            BackupStatus {
                ok: true,
                path: Some(copy.to_string_lossy().into_owned()),
                error: None,
                at: 5
            }
        );
        assert_eq!(
            BackupStatus::from_result(Ok(None), 6),
            BackupStatus {
                ok: true,
                path: None,
                error: None,
                at: 6
            }
        );
        let failed = BackupStatus::from_result(Err("disk full".into()), 7);
        assert_eq!(
            serde_json::to_value(&failed).unwrap(),
            json!({ "ok": false, "path": null, "error": "disk full", "at": 7 })
        );
    }

    #[test]
    fn empty_batch_is_a_no_op() {
        tauri::async_runtime::block_on(async {
            let pool = pool().await;
            run_batch(&pool, &[]).await.unwrap();
            assert_eq!(count(&pool).await, 0);
        });
    }
}
