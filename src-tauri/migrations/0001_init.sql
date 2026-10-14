-- Local store, spec §8.1. History tables are append-only; module_state and ratings are
-- caches rebuilt from history (rebuildCaches). Booleans are INTEGER 0/1, lists JSON text,
-- dates ISO-8601 text, ids UUID v4. sync_queue arrives in W2.

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY NOT NULL,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  kind        TEXT NOT NULL,
  phase       TEXT NOT NULL,
  app_version TEXT NOT NULL
);

CREATE TABLE blocks (
  id           TEXT PRIMARY KEY NOT NULL,
  session_id   TEXT NOT NULL REFERENCES sessions (id),
  module       TEXT NOT NULL,
  l_before     REAL NOT NULL,
  l_after      REAL NOT NULL,
  params_json  TEXT NOT NULL,
  score        REAL NOT NULL,
  flags_json   TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  summary_json TEXT NOT NULL
);
CREATE INDEX idx_blocks_session ON blocks (session_id);

CREATE TABLE trials (
  id            TEXT PRIMARY KEY NOT NULL,
  block_id      TEXT NOT NULL REFERENCES blocks (id),
  idx           INTEGER NOT NULL,
  stimulus_json TEXT NOT NULL,
  response_json TEXT NOT NULL,
  onset_ts      REAL,
  response_ts   REAL,
  rt_ms         REAL,
  outcome       TEXT NOT NULL,
  frame_dropped INTEGER NOT NULL
);
CREATE INDEX idx_trials_block ON trials (block_id);

CREATE TABLE logic_items (
  id         TEXT PRIMARY KEY NOT NULL,
  block_id   TEXT NOT NULL REFERENCES blocks (id),
  family     TEXT NOT NULL,
  seed       INTEGER NOT NULL,
  difficulty REAL NOT NULL,
  answer     INTEGER NOT NULL,
  given      INTEGER,
  correct    INTEGER NOT NULL,
  time_ms    REAL NOT NULL,
  at         TEXT NOT NULL
);
CREATE INDEX idx_logic_items_block ON logic_items (block_id);

CREATE TABLE diagnostics (
  id           TEXT PRIMARY KEY NOT NULL,
  session_id   TEXT NOT NULL REFERENCES sessions (id),
  number       INTEGER NOT NULL,
  at           TEXT NOT NULL,
  results_json TEXT NOT NULL
);

CREATE TABLE wellbeing (
  id       TEXT PRIMARY KEY NOT NULL,
  date     TEXT NOT NULL,
  sleep_h  REAL NOT NULL,
  caffeine INTEGER NOT NULL,
  mood     INTEGER NOT NULL
);

CREATE TABLE module_state (
  module                  TEXT PRIMARY KEY NOT NULL,
  l_saved                 REAL NOT NULL,
  session_end_levels_json TEXT NOT NULL,
  saved_history_json      TEXT NOT NULL,
  plateau                 INTEGER NOT NULL,
  last_trained_at         TEXT,
  lifetime_blocks         INTEGER NOT NULL
);

CREATE TABLE ratings (
  family     TEXT PRIMARY KEY NOT NULL,
  rating     REAL NOT NULL,
  n          INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

CREATE TABLE app_log (
  id      TEXT PRIMARY KEY NOT NULL,
  at      TEXT NOT NULL,
  level   TEXT NOT NULL,
  message TEXT NOT NULL,
  detail  TEXT NOT NULL
);
