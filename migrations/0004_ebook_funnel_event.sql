-- 0004 — ebook_funnel_event (CIEL mumate-manychat-ebook-001 slice 4): one row per funnel step a ManyChat contact
-- reached in the live E-Book flow, and the FU1 reason they chose. bdash reads it for the E-Book summary page.
-- ADDITIVE ONLY and idempotent. No message text: a step name and one value from the app's fixed list (src/funnel.ts).
-- Apply BY HAND: staging = pgstaging on mumate-2; production = Supabase on the owner's word through bin/prod-sql.sh.
CREATE TABLE IF NOT EXISTS ebook_funnel_event (
  id            bigserial   PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  env           text        NOT NULL CHECK (env IN ('staging', 'production', 'development')),
  subscriber_id text        NOT NULL CHECK (subscriber_id ~ '^[0-9]{1,20}$'),
  step          text        NOT NULL CHECK (step IN ('entry', 'sample', 'faq', 'buy', 'reason_asked', 'reason')),
  value         text        CHECK (value IS NULL OR value ~ '^[a-z_]{1,20}$')
);
CREATE INDEX IF NOT EXISTS ebook_funnel_event_env_at_idx ON ebook_funnel_event (env, at DESC);
CREATE INDEX IF NOT EXISTS ebook_funnel_event_env_step_idx ON ebook_funnel_event (env, step, at DESC);

-- the app's production role (see 0003) writes and reads this table too; nothing else
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ebook_app') THEN
    GRANT SELECT, INSERT ON ebook_funnel_event TO ebook_app;
    GRANT USAGE, SELECT ON SEQUENCE ebook_funnel_event_id_seq TO ebook_app;
  END IF;
END
$grants$;
