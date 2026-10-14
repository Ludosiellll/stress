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
/// plugin first guarantees no webview has loaded the database yet. A failed backup is
/// reported and does not stop the app.
fn backup_plugin<R: Runtime>() -> TauriPlugin<R> {
    PluginBuilder::new("db-backup")
        .setup(|app, _api| {
            let dir = app.path().app_config_dir()?;
            let version = app.package_info().version.to_string();
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |d| d.as_secs());
            if let Err(e) = backup::run_backup_if_needed(
                &dir.join(DB_FILE),
                &dir.join(BACKUP_DIR),
                &version,
                now,
            ) {
                eprintln!("database backup failed: {e}");
            }
            Ok(())
        })
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(backup_plugin())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(DB_URL, migrations())
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            commands::db_batch,
            commands::export_file
        ])
        .run(tauri::generate_context!())
        .expect("ошибка при запуске приложения");
}

#[cfg(test)]
mod tests {
    use super::*;

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
