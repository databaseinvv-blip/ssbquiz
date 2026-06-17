-- ============================================================
-- SSB Capital Readiness Test — schema
-- Run this against the NEW "ssb" database (not your other DBs).
--   psql "host=... dbname=ssb user=ssb_app" -f schema.sql
-- ============================================================

-- Reference table: one row per question, seeded once from the JS banks.
CREATE TABLE IF NOT EXISTS questions (
  id            TEXT PRIMARY KEY,        -- e.g. "fnb_d0_0"  (industry _ dimension _ original-index)
  industry      TEXT NOT NULL,           -- fnb, services, retail, ...
  dimension     SMALLINT NOT NULL,       -- 0..5  (S1..S6)
  question_zh   TEXT NOT NULL,
  question_en   TEXT
);

-- One row per completed test.
CREATE TABLE IF NOT EXISTS submissions (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  name                TEXT,
  email               TEXT,
  phone               TEXT,
  projected_pat       NUMERIC,
  industry            TEXT,
  industry_label      TEXT,
  pattern             TEXT,               -- e.g. "HML"
  estimated_pe        NUMERIC,
  estimated_valuation NUMERIC,
  scalability         SMALLINT,
  sustainability      SMALLINT,
  brand_influence     SMALLINT,
  s1_system           SMALLINT,
  s2_replication      SMALLINT,
  s3_moat             SMALLINT,
  s4_finance          SMALLINT,
  s5_voice            SMALLINT,
  s6_brand_indep      SMALLINT,
  pdf_url             TEXT,               -- public/object URL in GCS
  pdf_path            TEXT,               -- object path within the bucket
  email_status        TEXT                -- 'sent' / 'failed' / 'skipped'
);

-- One row per answered question, linked to a submission.
-- Question text + chosen option are DENORMALIZED (snapshotted) so old
-- submissions stay readable even after you reword a question later.
CREATE TABLE IF NOT EXISTS answers (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  submission_id  BIGINT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  question_id    TEXT REFERENCES questions(id),
  dimension      SMALLINT,
  question_zh    TEXT,
  chosen_zh      TEXT,
  chosen_en      TEXT,
  score          NUMERIC                  -- 0 / 1 / 1.5 / 2 / 3
);

CREATE INDEX IF NOT EXISTS idx_answers_submission ON answers (submission_id);
CREATE INDEX IF NOT EXISTS idx_submissions_created ON submissions (created_at);
CREATE INDEX IF NOT EXISTS idx_submissions_email   ON submissions (email);
