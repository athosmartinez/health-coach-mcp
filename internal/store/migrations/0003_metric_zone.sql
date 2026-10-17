-- The IANA zone a cached value was computed in: sleep start minutes and the
-- day a night belongs to depend on it, so a row from another zone is a miss.
ALTER TABLE daily_metrics ADD COLUMN zone TEXT;
