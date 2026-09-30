-- Resume files ingested from the recruiter's disk, keyed by absolute path. Folder ingest skips a file whose size and
-- mtime are unchanged without reading or hashing it, and retries failures up to a limit.
CREATE TABLE source_files (
  path text PRIMARY KEY,
  size_bytes bigint NOT NULL,
  mtime_ns bigint NOT NULL,
  sha256 text,
  status text NOT NULL,                         -- created | updated | duplicate_file | failed
  candidate_id uuid REFERENCES candidates(id) ON DELETE CASCADE,
  error text,
  attempts int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
