-- Schema v1 (docs/CAPABILITY.md §5.2). schema_migrations is created by the
-- migrator itself, since it must exist before any migration is checked.
-- Dates are YYYY-MM-DD local days; timestamps are RFC 3339 UTC.

CREATE TABLE profile (
  id          INTEGER PRIMARY KEY CHECK (id = 1),          -- singleton (R1)
  birth_date  TEXT, sex TEXT, height_cm REAL,
  goal_json   TEXT,          -- {type, target_weight_kg, target_body_fat_pct, deadline}
  plan_json   TEXT,          -- {split, notes}; weekly target lives only in `targets`
  updated_at  TEXT NOT NULL
);

CREATE TABLE targets (
  effective_from  TEXT PRIMARY KEY,                          -- YYYY-MM-DD (I6)
  kcal            INTEGER, protein_g INTEGER, weekly_sessions INTEGER,
  created_at      TEXT NOT NULL
);

CREATE TABLE health_items (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('condition','medication','supplement','injury','allergy','restriction')),
  name TEXT NOT NULL COLLATE NOCASE,   -- "Knee" and "knee" are the same item
  status TEXT NOT NULL CHECK (status IN ('active','resolved','paused')),
  details TEXT, started_on TEXT, ended_on TEXT, updated_at TEXT NOT NULL,
  UNIQUE (kind, name)
);

CREATE TABLE lab_results (
  id INTEGER PRIMARY KEY,
  collected_on TEXT NOT NULL, lab TEXT,
  analyte TEXT NOT NULL,     -- normalized name: ldl, hdl, hba1c, glucose_fasting, tsh…
  value REAL NOT NULL, unit TEXT NOT NULL, ref_low REAL, ref_high REAL,
  source TEXT NOT NULL CHECK (source IN ('pdf','chat','file')),
  created_at TEXT NOT NULL,
  UNIQUE (collected_on, analyte)
);

CREATE TABLE preferences (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,  -- never reused: ids order notes and key the FTS index
  kind TEXT NOT NULL CHECK (kind IN ('insight','decision','checkin','symptom')),
  text TEXT NOT NULL,
  tags TEXT,                 -- JSON array of strings
  related_date TEXT, created_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE notes_fts USING fts5(text, content='notes', content_rowid='id');
-- external-content FTS5 is only populated via triggers
CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, text) VALUES (new.id, new.text); END;
CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, text) VALUES ('delete', old.id, old.text); END;
CREATE TRIGGER notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO notes_fts(rowid, text) VALUES (new.id, new.text); END;

CREATE TABLE daily_metrics (                                 -- cache (5.3)
  date TEXT NOT NULL, metric TEXT NOT NULL,                  -- metric from the closed list in 5.3
  value REAL NOT NULL, n_samples INTEGER, source TEXT,
  algo_version INTEGER NOT NULL,                             -- bump when the derivation changes
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (date, metric)
);
