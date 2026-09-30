CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE candidates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text,
  email          text UNIQUE,
  phone          text,
  phone_key      text,                         -- last 10 digits, for dedup
  location       text,
  years_exp      numeric(4,1),
  notice_days    int,
  skills         text[] NOT NULL DEFAULT '{}',
  profile        jsonb NOT NULL,
  raw_extraction jsonb NOT NULL,
  summary        text NOT NULL,
  resume_text    text NOT NULL,                -- transcript sent by the assistant
  embedding      vector({EMBED_DIM}) NOT NULL,
  content_sha256 text NOT NULL,                -- sha256 of original file if given, else of normalized text
  file_key       text,                         -- relative path under DATA_DIR; null if no original sent
  file_mime      text,
  source         text,
  notes          text,
  created_at     timestamptz DEFAULT now(),
  updated_at     timestamptz DEFAULT now()
);
CREATE INDEX candidates_embedding_idx ON candidates USING hnsw (embedding vector_cosine_ops);
CREATE INDEX candidates_skills_idx ON candidates USING gin (skills);
CREATE INDEX candidates_name_trgm_idx ON candidates USING gin (name gin_trgm_ops);
CREATE UNIQUE INDEX candidates_content_sha256_idx ON candidates (content_sha256);
CREATE INDEX candidates_phone_key_idx ON candidates (phone_key);
CREATE INDEX candidates_updated_at_idx ON candidates (updated_at);

CREATE TABLE candidate_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid REFERENCES candidates(id) ON DELETE CASCADE,
  profile        jsonb,
  resume_text    text,
  file_key       text,
  content_sha256 text,
  created_at   timestamptz DEFAULT now()
);

CREATE TABLE jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title        text,
  jd_text      text NOT NULL,
  requirements jsonb NOT NULL,
  filters      jsonb,
  funnel       jsonb,
  embedding    vector({EMBED_DIM}) NOT NULL,
  created_at   timestamptz DEFAULT now()
);

CREATE TABLE matches (
  job_id         uuid REFERENCES jobs(id) ON DELETE CASCADE,
  candidate_id   uuid REFERENCES candidates(id) ON DELETE CASCADE,
  score          int,
  rank           int,
  result         jsonb,
  feedback_label text,
  feedback_note  text,
  created_at     timestamptz DEFAULT now(),
  PRIMARY KEY (job_id, candidate_id)
);

CREATE TABLE skill_synonyms (
  alias     text PRIMARY KEY,
  canonical text NOT NULL
);

CREATE TABLE usage (
  id            bigserial PRIMARY KEY,
  tool          text NOT NULL,
  request_id    uuid,
  kind          text NOT NULL,          -- llm | embedding
  model         text,
  input_tokens  int DEFAULT 0,
  output_tokens int DEFAULT 0,
  cache_read_tokens int DEFAULT 0,
  cost_usd      numeric(12,6),
  created_at    timestamptz DEFAULT now()
);
CREATE INDEX usage_created_at_idx ON usage (created_at);
CREATE INDEX candidate_versions_sha_idx ON candidate_versions (content_sha256);
