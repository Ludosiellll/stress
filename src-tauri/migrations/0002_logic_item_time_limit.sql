-- 0.2.0: per-item time limit of a number-series item, ms (plan W2, R36).
-- NULL: rows written before 0.2.0 (40 000 ms) and diagnostic items (no per-item limit).
ALTER TABLE logic_items ADD COLUMN time_limit_ms REAL;
