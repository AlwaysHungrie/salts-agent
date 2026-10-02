-- Relocation: a candidate outside the job's cities still passes the location filter when they are willing to move
-- (anywhere, or to one of their preferred locations). Filled at ingest; `migrate` backfills from profile JSON.
ALTER TABLE candidates ADD COLUMN willing_to_relocate boolean;
ALTER TABLE candidates ADD COLUMN preferred_location_keys text[] NOT NULL DEFAULT '{}';
CREATE INDEX candidates_preferred_location_keys_idx ON candidates USING gin (preferred_location_keys);

-- Skills first seen in a resume or JD are stored as 'learned' aliases, so the vocabulary grows and one spelling
-- sticks. Seed rows are overwritten from seeds/skill_synonyms.csv on every migrate; learned rows are not.
ALTER TABLE skill_synonyms ADD COLUMN source text NOT NULL DEFAULT 'seed';

-- Profiles stored before these fields existed: add them empty so they validate as CandidateProfile.
UPDATE candidates SET profile = profile || '{"willing_to_relocate": null, "preferred_locations": []}'::jsonb
  WHERE NOT profile ? 'preferred_locations';
UPDATE candidate_versions SET profile = profile || '{"willing_to_relocate": null, "preferred_locations": []}'::jsonb
  WHERE profile IS NOT NULL AND NOT profile ? 'preferred_locations';
