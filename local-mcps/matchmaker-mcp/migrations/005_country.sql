-- Countries a candidate is based in, from their location ('Remote (India)', 'Pune', 'Berlin'), so a search for
-- people in a country excludes those elsewhere. Empty when unrecognised. Filled at ingest; `migrate` backfills.
ALTER TABLE candidates ADD COLUMN country_keys text[] NOT NULL DEFAULT '{}';
CREATE INDEX candidates_country_keys_idx ON candidates USING gin (country_keys);
