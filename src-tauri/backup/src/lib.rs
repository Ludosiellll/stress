//! Backups of the SQLite file and safe export writes. No Tauri dependency, so the tests
//! run anywhere (`cargo test --manifest-path src-tauri/backup/Cargo.toml`).

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// How many backup copies are kept (spec §8.1).
pub const KEEP: usize = 8;
/// A new copy is made when the newest one is at least this old.
pub const MAX_AGE_SECS: u64 = 7 * 24 * 60 * 60;

const PREFIX: &str = "trainer-";
const SUFFIX: &str = ".db";
const VERSION_FILE: &str = "last_version";
/// SQLite side files that hold committed (WAL) or to-be-rolled-back (hot journal) pages.
/// They are copied with the database so the copy opens in the same state as the original.
const COMPANIONS: [&str; 2] = ["-journal", "-wal"];

/// Copies `db` to `dir/trainer-<unix>.db` when the database exists and the version in
/// `dir/last_version` differs from `app_version`, or there is no copy yet, or the newest
/// copy is at least 7 days old. Keeps the 8 newest copies, then records the version.
/// Returns the path of the new copy, or `None` when nothing was needed.
///
/// Call it before anything opens the database. The copy goes through a `.tmp` file and a
/// rename, so a half-written copy never looks like a backup. If the clock is behind the
/// newest copy, the new copy is named one second after it so it still counts as newest.
///
/// Nothing is left behind on failure: a failed attempt removes every file it wrote for its
/// stamp, and each run first removes stale `.tmp` files and side files whose copy is gone
/// (e.g. after a crash), so retries on a nearly full disk do not eat the space the live
/// database needs.
pub fn run_backup_if_needed(
    db: &Path,
    dir: &Path,
    app_version: &str,
    now_unix: u64,
) -> io::Result<Option<PathBuf>> {
    if !db.is_file() {
        return Ok(None);
    }
    fs::create_dir_all(dir)?;
    remove_stale(dir);
    let newest = list_backups(dir)?.into_iter().max();
    let last_version = match fs::read_to_string(dir.join(VERSION_FILE)) {
        Ok(v) => Some(v.trim().to_owned()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        Err(e) => return Err(e),
    };
    let needed = last_version.as_deref() != Some(app_version)
        || newest.is_none_or(|n| now_unix.saturating_sub(n) >= MAX_AGE_SECS);
    if !needed {
        return Ok(None);
    }

    let stamp = match newest {
        Some(n) if now_unix <= n => n + 1,
        _ => now_unix,
    };
    let target = dir.join(format!("{PREFIX}{stamp}{SUFFIX}"));
    if let Err(e) = copy_with_side_files(db, &target) {
        remove_copy(&target);
        return Err(e);
    }
    prune(dir);
    write_atomic(&dir.join(VERSION_FILE), app_version.as_bytes())?;
    Ok(Some(target))
}

/// The database first (the bulk of the space), then its side files.
fn copy_with_side_files(db: &Path, target: &Path) -> io::Result<()> {
    copy_atomic(db, target)?;
    for suffix in COMPANIONS {
        let side = companion(db, suffix);
        if side.is_file() {
            copy_atomic(&side, &companion(target, suffix))?;
        }
    }
    Ok(())
}

/// Removes a copy with its side files and their temp files. Best effort.
fn remove_copy(target: &Path) {
    let _ = fs::remove_file(target);
    let _ = fs::remove_file(tmp_path(target));
    for suffix in COMPANIONS {
        let side = companion(target, suffix);
        let _ = fs::remove_file(tmp_path(&side));
        let _ = fs::remove_file(side);
    }
}

/// Writes `contents` to `dir/name` (replacing an existing file) and returns the path.
/// `name` must be a plain file name: no path separators, drive colon, NUL or "..".
pub fn write_export(dir: &Path, name: &str, contents: &str) -> io::Result<PathBuf> {
    let bad = name.is_empty()
        || name == "."
        || name.contains("..")
        || name.contains(['/', '\\', ':', '\0']);
    if bad {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("unsafe export file name: {name:?}"),
        ));
    }
    let path = dir.join(name);
    write_atomic(&path, contents.as_bytes())?;
    Ok(path)
}

/// `path` with `suffix` appended to its file name (`a.db` + `-wal` → `a.db-wal`).
fn companion(path: &Path, suffix: &str) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

fn tmp_path(path: &Path) -> PathBuf {
    companion(path, ".tmp")
}

// Syncing needs a writable handle: on Windows `sync_all` is FlushFileBuffers, which fails
// with "Access is denied" on a handle opened read-only (`File::open`).

fn copy_atomic(from: &Path, to: &Path) -> io::Result<()> {
    let tmp = tmp_path(to);
    let result = (|| {
        fs::copy(from, &tmp)?;
        fs::OpenOptions::new().write(true).open(&tmp)?.sync_all()?;
        fs::rename(&tmp, to)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let tmp = tmp_path(path);
    let result = (|| {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Timestamps of `trainer-<digits>.db` files in `dir`; other entries are ignored.
fn list_backups(dir: &Path) -> io::Result<Vec<u64>> {
    let mut stamps = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(digits) = name
            .strip_prefix(PREFIX)
            .and_then(|r| r.strip_suffix(SUFFIX))
        else {
            continue;
        };
        if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
            if let Ok(n) = digits.parse() {
                stamps.push(n);
            }
        }
    }
    Ok(stamps)
}

/// Removes files a crashed or failed run left: `trainer-*.tmp`, `last_version.tmp`, and
/// side files (`trainer-<stamp>.db-journal` / `-wal`) whose `trainer-<stamp>.db` is gone. Best effort.
fn remove_stale(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let stale_tmp = (name.starts_with(PREFIX) && name.ends_with(".tmp"))
            || name == format!("{VERSION_FILE}.tmp");
        let orphan_side = name.starts_with(PREFIX)
            && COMPANIONS.iter().any(|suffix| {
                name.strip_suffix(suffix).is_some_and(|db_name| {
                    db_name.ends_with(SUFFIX) && !dir.join(db_name).is_file()
                })
            });
        if stale_tmp || orphan_side {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// Removes all but the KEEP newest copies with their side files. Best effort: a file that
/// cannot be removed now (e.g. locked by an antivirus) is retried on the next backup.
fn prune(dir: &Path) {
    let Ok(mut stamps) = list_backups(dir) else {
        return;
    };
    stamps.sort_unstable_by(|a, b| b.cmp(a));
    for stamp in stamps.into_iter().skip(KEEP) {
        let path = dir.join(format!("{PREFIX}{stamp}{SUFFIX}"));
        let _ = fs::remove_file(&path);
        for suffix in COMPANIONS {
            let _ = fs::remove_file(companion(&path, suffix));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    const DAY: u64 = 86_400;
    const T0: u64 = 1_790_000_000;

    struct Env {
        _tmp: TempDir,
        db: PathBuf,
        dir: PathBuf,
    }

    fn env_with_db() -> Env {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("trainer.db");
        fs::write(&db, b"SQLite format 3\0 history").unwrap();
        let dir = tmp.path().join("backups");
        Env { _tmp: tmp, db, dir }
    }

    fn backups(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("trainer-"))
            .collect();
        names.sort();
        names
    }

    #[test]
    fn no_database_means_no_backup() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("backups");
        let r = run_backup_if_needed(&tmp.path().join("trainer.db"), &dir, "0.1.0", T0).unwrap();
        assert_eq!(r, None);
        assert!(!dir.exists());
    }

    #[test]
    fn first_run_copies_and_records_version() {
        let e = env_with_db();
        let r = run_backup_if_needed(&e.db, &e.dir, "0.1.0", T0).unwrap();
        let expected = e.dir.join(format!("trainer-{T0}.db"));
        assert_eq!(r, Some(expected.clone()));
        assert_eq!(fs::read(&expected).unwrap(), fs::read(&e.db).unwrap());
        assert_eq!(
            fs::read_to_string(e.dir.join("last_version")).unwrap(),
            "0.1.0"
        );
        assert_eq!(backups(&e.dir), vec![format!("trainer-{T0}.db")]);
    }

    #[test]
    fn same_version_and_fresh_copy_skips() {
        let e = env_with_db();
        run_backup_if_needed(&e.db, &e.dir, "0.1.0", T0).unwrap();
        let r = run_backup_if_needed(&e.db, &e.dir, "0.1.0", T0 + 7 * DAY - 1).unwrap();
        assert_eq!(r, None);
        assert_eq!(backups(&e.dir).len(), 1);
    }

    #[test]
    fn copy_older_than_seven_days_triggers_backup() {
        let e = env_with_db();
        run_backup_if_needed(&e.db, &e.dir, "0.1.0", T0).unwrap();
        let r = run_backup_if_needed(&e.db, &e.dir, "0.1.0", T0 + 7 * DAY).unwrap();
        assert_eq!(r, Some(e.dir.join(format!("trainer-{}.db", T0 + 7 * DAY))));
        assert_eq!(backups(&e.dir).len(), 2);
    }

    #[test]
    fn version_change_triggers_backup() {
        let e = env_with_db();
        run_backup_if_needed(&e.db, &e.dir, "0.1.0", T0).unwrap();
        let r = run_backup_if_needed(&e.db, &e.dir, "0.2.0", T0 + 60).unwrap();
        assert_eq!(r, Some(e.dir.join(format!("trainer-{}.db", T0 + 60))));
        assert_eq!(
            fs::read_to_string(e.dir.join("last_version")).unwrap(),
            "0.2.0"
        );
    }

    #[test]
    fn missing_copies_trigger_backup_even_with_same_version() {
        let e = env_with_db();
        fs::create_dir_all(&e.dir).unwrap();
        fs::write(e.dir.join("last_version"), "0.1.0").unwrap();
        let r = run_backup_if_needed(&e.db, &e.dir, "0.1.0", T0).unwrap();
        assert!(r.is_some());
    }

    #[test]
    fn ten_runs_with_new_versions_keep_the_eight_newest() {
        let e = env_with_db();
        for i in 0..10u64 {
            let r = run_backup_if_needed(&e.db, &e.dir, &format!("0.{i}.0"), T0 + i * 60).unwrap();
            assert!(r.is_some());
        }
        let expected: Vec<String> = (2..10u64)
            .map(|i| format!("trainer-{}.db", T0 + i * 60))
            .collect();
        assert_eq!(backups(&e.dir), expected);
    }

    #[test]
    fn pruning_ignores_foreign_files() {
        let e = env_with_db();
        fs::create_dir_all(&e.dir).unwrap();
        fs::write(e.dir.join("notes.txt"), "keep").unwrap();
        fs::write(e.dir.join("trainer-abc.db"), "keep").unwrap();
        for i in 0..9u64 {
            run_backup_if_needed(&e.db, &e.dir, &format!("v{i}"), T0 + i).unwrap();
        }
        assert!(e.dir.join("notes.txt").exists());
        assert!(e.dir.join("trainer-abc.db").exists());
        let ours = backups(&e.dir)
            .into_iter()
            .filter(|n| n != "trainer-abc.db")
            .count();
        assert_eq!(ours, KEEP);
    }

    #[test]
    fn clock_behind_newest_copy_still_sorts_newest() {
        let e = env_with_db();
        run_backup_if_needed(&e.db, &e.dir, "0.1.0", T0).unwrap();
        let r = run_backup_if_needed(&e.db, &e.dir, "0.2.0", T0 - DAY).unwrap();
        assert_eq!(r, Some(e.dir.join(format!("trainer-{}.db", T0 + 1))));
    }

    #[test]
    fn copies_journal_and_wal_companions() {
        let e = env_with_db();
        fs::write(e.db.with_file_name("trainer.db-journal"), b"journal").unwrap();
        fs::write(e.db.with_file_name("trainer.db-wal"), b"wal").unwrap();
        let copy = run_backup_if_needed(&e.db, &e.dir, "0.1.0", T0)
            .unwrap()
            .unwrap();
        assert_eq!(fs::read(companion(&copy, "-journal")).unwrap(), b"journal");
        assert_eq!(fs::read(companion(&copy, "-wal")).unwrap(), b"wal");
        for i in 1..=KEEP as u64 {
            run_backup_if_needed(&e.db, &e.dir, &format!("v{i}"), T0 + i).unwrap();
        }
        assert!(!copy.exists());
        assert!(!companion(&copy, "-journal").exists());
        assert!(!companion(&copy, "-wal").exists());
    }

    #[test]
    fn no_temp_file_is_left_behind() {
        let e = env_with_db();
        run_backup_if_needed(&e.db, &e.dir, "0.1.0", T0).unwrap();
        let tmp: Vec<_> = fs::read_dir(&e.dir)
            .unwrap()
            .filter(|x| {
                x.as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".tmp")
            })
            .collect();
        assert!(tmp.is_empty());
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn failed_database_copy_leaves_no_temp_file() {
        // A directory where the copy must land makes the final rename fail after the
        // DB-sized temp file was written.
        let e = env_with_db();
        fs::create_dir_all(e.dir.join(format!("trainer-{T0}.db"))).unwrap();
        fs::write(e.db.with_file_name("trainer.db-journal"), b"journal").unwrap();
        assert!(run_backup_if_needed(&e.db, &e.dir, "0.1.0", T0).is_err());
        assert_eq!(names(&e.dir), vec![format!("trainer-{T0}.db")]);
    }

    #[test]
    fn failed_side_file_copy_removes_everything_of_that_stamp() {
        let e = env_with_db();
        fs::write(e.db.with_file_name("trainer.db-wal"), b"wal").unwrap();
        let blocker = format!("trainer-{T0}.db-wal.tmp");
        fs::create_dir_all(e.dir.join(&blocker)).unwrap();
        assert!(run_backup_if_needed(&e.db, &e.dir, "0.1.0", T0).is_err());
        // Only the blocker is left: no copy, no temp file, no last_version.
        assert_eq!(names(&e.dir), vec![blocker]);
    }

    #[test]
    fn stale_temp_and_orphan_side_files_are_removed() {
        let e = env_with_db();
        fs::create_dir_all(&e.dir).unwrap();
        for stale in [
            "trainer-100.db.tmp",
            "trainer-100.db-wal.tmp",
            "trainer-200.db-journal",
            "trainer-300.db-wal",
            "last_version.tmp",
        ] {
            fs::write(e.dir.join(stale), b"stale").unwrap();
        }
        fs::write(e.dir.join("notes.txt"), b"keep").unwrap();
        fs::write(e.db.with_file_name("trainer.db-wal"), b"wal").unwrap();
        let copy = run_backup_if_needed(&e.db, &e.dir, "0.1.0", T0)
            .unwrap()
            .unwrap();
        assert!(copy.exists());
        assert_eq!(
            names(&e.dir),
            vec![
                "last_version".to_string(),
                "notes.txt".into(),
                format!("trainer-{T0}.db"),
                format!("trainer-{T0}.db-wal"),
            ]
        );
    }

    #[test]
    fn stale_files_are_removed_even_when_no_backup_is_due() {
        let e = env_with_db();
        run_backup_if_needed(&e.db, &e.dir, "0.1.0", T0).unwrap();
        fs::write(e.dir.join("trainer-5.db.tmp"), b"stale").unwrap();
        assert_eq!(
            run_backup_if_needed(&e.db, &e.dir, "0.1.0", T0 + 1).unwrap(),
            None
        );
        assert!(!e.dir.join("trainer-5.db.tmp").exists());
    }

    #[test]
    fn directories_named_like_copies_are_not_counted() {
        let e = env_with_db();
        fs::create_dir_all(e.dir.join("trainer-99999999999.db")).unwrap();
        let r = run_backup_if_needed(&e.db, &e.dir, "0.1.0", T0).unwrap();
        assert_eq!(r, Some(e.dir.join(format!("trainer-{T0}.db"))));
    }

    #[test]
    fn failed_export_leaves_no_temp_file() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("out.json")).unwrap();
        assert!(write_export(tmp.path(), "out.json", "x").is_err());
        assert_eq!(names(tmp.path()), vec!["out.json".to_string()]);
    }

    #[test]
    fn export_writes_the_file_and_returns_its_path() {
        let tmp = tempfile::tempdir().unwrap();
        let p = write_export(tmp.path(), "stress-export-2026-10-14.json", "{\"a\":1}").unwrap();
        assert_eq!(p, tmp.path().join("stress-export-2026-10-14.json"));
        assert_eq!(fs::read_to_string(&p).unwrap(), "{\"a\":1}");
        let again = write_export(tmp.path(), "stress-export-2026-10-14.json", "новое").unwrap();
        assert_eq!(fs::read_to_string(again).unwrap(), "новое");
    }

    #[test]
    fn export_rejects_unsafe_names() {
        let tmp = tempfile::tempdir().unwrap();
        for bad in [
            "",
            ".",
            "..",
            "../x.json",
            "a/b.json",
            "a\\b.json",
            "..\\x",
            "C:x.json",
            "x..json",
            "a\0b",
        ] {
            let err = write_export(tmp.path(), bad, "x").unwrap_err();
            assert_eq!(err.kind(), io::ErrorKind::InvalidInput, "name {bad:?}");
        }
        assert_eq!(fs::read_dir(tmp.path()).unwrap().count(), 0);
    }
}
