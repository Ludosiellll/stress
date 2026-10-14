mod commands;

use tauri_plugin_sql::Migration;

/// Миграции локальной БД. Схема появится в задаче с репозиторием данных.
fn migrations() -> Vec<Migration> {
    Vec::new()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:stress.db", migrations())
                .build(),
        )
        .invoke_handler(tauri::generate_handler![])
        .run(tauri::generate_context!())
        .expect("ошибка при запуске приложения");
}
