mod commands;

use std::time::{SystemTime, UNIX_EPOCH};

use tauri::plugin::{Builder as PluginBuilder, TauriPlugin};
use tauri::{Manager, Runtime};
use tauri_plugin_sql::{Migration, MigrationKind};

/// Connection string the frontend passes to `Database.load` and `db_batch`.
pub const DB_URL: &str = "sqlite:trainer.db";
/// tauri-plugin-sql 2.5.0 resolves `sqlite:<file>` against `app_config_dir()` (wrapper.rs:89-96).
const DB_FILE: &str = "trainer.db";
const BACKUP_DIR: &str = "backups";

/// Versioned schema migrations; the plugin runs them when the frontend loads the database.
fn migrations() -> Vec<Migration> {
    vec![Migration {
        version: 1,
        description: "init",
        sql: include_str!("../migrations/0001_init.sql"),
        kind: MigrationKind::Up,
    }]
}

/// Backs up the database file before anything can open it. Plugins are initialized in
/// registration order inside `Builder::build` (tauri 2.12 app.rs:2607), before the windows
/// are created and before the app `setup` hook runs (app.rs:2691-2698), so registering this
/// plugin first guarantees no webview has loaded the database yet. A failed backup does not
/// stop the app: the outcome is kept as `BackupStatus` state for the `backup_status` command (R21).
fn backup_plugin<R: Runtime>() -> TauriPlugin<R> {
    PluginBuilder::new("db-backup")
        .setup(|app, _api| {
            let version = app.package_info().version.to_string();
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |d| d.as_secs());
            let result = app
                .path()
                .app_config_dir()
                .map_err(|e| e.to_string())
                .and_then(|dir| {
                    backup::run_backup_if_needed(
                        &dir.join(DB_FILE),
                        &dir.join(BACKUP_DIR),
                        &version,
                        now,
                    )
                    .map_err(|e| e.to_string())
                });
            let status = commands::BackupStatus::from_result(result, now);
            if let Some(e) = &status.error {
                eprintln!("database backup failed: {e}");
            }
            app.manage(status);
            Ok(())
        })
        .build()
}

/// Label of the window from tauri.conf.json (the default label of the first window).
const MAIN_WINDOW: &str = "main";

/// A second launch brings the running window forward instead of opening another app on the same
/// database (M7). Registered first: in the second process the plugin exits during its setup, before
/// the backup plugin or plugin-sql run.
fn focus_existing_window<R: Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            focus_existing_window(app);
        }))
        .plugin(backup_plugin())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(DB_URL, migrations())
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            commands::backup_status,
            commands::db_batch,
            commands::export_file
        ])
        .run(tauri::generate_context!())
        .expect("ошибка при запуске приложения");
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::migrate::{Migration as SqlxMigration, MigrationType, Migrator};
    use std::borrow::Cow;

    /// The plugin's conversion (tauri-plugin-sql 2.5.0 lib.rs:118-135): Up → ReversibleUp, no_tx false.
    fn sqlx_migrations() -> Vec<SqlxMigration> {
        migrations()
            .into_iter()
            .filter(|m| matches!(m.kind, MigrationKind::Up))
            .map(|m| {
                SqlxMigration::new(
                    m.version,
                    m.description.into(),
                    MigrationType::ReversibleUp,
                    m.sql.into(),
                    false,
                )
            })
            .collect()
    }

    /// Same settings as `Migrator::new` (what the plugin calls).
    fn migrator() -> Migrator {
        Migrator {
            migrations: Cow::Owned(sqlx_migrations()),
            ..Migrator::DEFAULT
        }
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// Shipped migrations must never change: sqlx stores this SHA-384 per applied migration and
    /// refuses to open a database whose recorded checksum differs (VersionMismatch). Add a new
    /// migration file instead of editing an old one.
    #[test]
    fn shipped_migration_checksums_are_pinned() {
        let pinned: [(i64, &str); 1] = [(
            1,
            "accc2b179dca5ad7a8c2a5305afc88a738f6bdbcbe540fa0d3a991f45e3b790a9f717ee301c6afa43dc0cb4b3be2293b",
        )];
        let actual: Vec<(i64, String)> = sqlx_migrations()
            .iter()
            .map(|m| (m.version, hex(&m.checksum)))
            .collect();
        for (version, sum) in pinned {
            let found = actual.iter().find(|(v, _)| *v == version);
            assert_eq!(
                found.map(|(_, s)| s.as_str()),
                Some(sum),
                "migration {version} changed"
            );
        }
    }

    #[test]
    fn migrator_runs_once_and_is_a_no_op_on_the_next_start() {
        tauri::async_runtime::block_on(async {
            let dir = tempfile::tempdir().unwrap();
            let options = sqlx::sqlite::SqliteConnectOptions::new()
                .filename(dir.path().join("trainer.db"))
                .create_if_missing(true);
            let pool = sqlx::SqlitePool::connect_with(options.clone())
                .await
                .unwrap();
            migrator().run(&pool).await.unwrap();
            sqlx::query("INSERT INTO settings (key, value) VALUES ('layout', '\"pult\"')")
                .execute(&pool)
                .await
                .unwrap();
            pool.close().await;

            // Next app start: a new pool, the same migrations.
            let pool = sqlx::SqlitePool::connect_with(options).await.unwrap();
            migrator().run(&pool).await.unwrap();
            let applied: Vec<(i64,)> = sqlx::query_as("SELECT version FROM _sqlx_migrations")
                .fetch_all(&pool)
                .await
                .unwrap();
            assert_eq!(applied, vec![(1,)]);
            let kept: (String,) = sqlx::query_as("SELECT value FROM settings WHERE key = 'layout'")
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(kept.0, "\"pult\"");
        });
    }

    #[test]
    fn migration_applies_on_sqlx_sqlite() {
        tauri::async_runtime::block_on(async {
            let pool = sqlx::sqlite::SqlitePoolOptions::new()
                .max_connections(1)
                .connect("sqlite::memory:")
                .await
                .unwrap();
            for m in migrations() {
                sqlx::raw_sql(m.sql).execute(&pool).await.unwrap();
            }
            let tables: Vec<(String,)> =
                sqlx::query_as("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
                    .fetch_all(&pool)
                    .await
                    .unwrap();
            let names: Vec<&str> = tables.iter().map(|t| t.0.as_str()).collect();
            assert_eq!(
                names,
                [
                    "app_log",
                    "blocks",
                    "diagnostics",
                    "logic_items",
                    "module_state",
                    "ratings",
                    "sessions",
                    "settings",
                    "trials",
                    "wellbeing"
                ]
            );
        });
    }
}
