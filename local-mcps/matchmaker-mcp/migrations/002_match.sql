-- Normalized city key for location filters (see locations.py). Backfill is approximate;
-- rows re-ingested or touched by the app get the full alias-aware key.
ALTER TABLE candidates ADD COLUMN location_key text;
UPDATE candidates SET location_key = lower(trim(split_part(location, ',', 1))) WHERE location IS NOT NULL;
CREATE INDEX candidates_location_key_idx ON candidates (location_key);
CREATE INDEX candidates_notice_days_idx ON candidates (notice_days);
CREATE INDEX candidates_years_exp_idx ON candidates (years_exp);

-- Match run stats: latency, token usage, cost.
ALTER TABLE jobs ADD COLUMN stats jsonb;
CREATE INDEX jobs_created_at_idx ON jobs (created_at DESC);
CREATE INDEX matches_job_rank_idx ON matches (job_id, rank);
