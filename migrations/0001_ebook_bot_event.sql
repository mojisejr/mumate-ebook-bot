-- 0001 — ebook_bot_event (CIEL mumate-manychat-ebook-001 slice 1): one row per thing the bot did for a ManyChat contact.
-- ADDITIVE ONLY and idempotent: no DROP, no DELETE, safe to run again.
-- Apply BY HAND: staging = pgstaging on mumate-2 (mumate-infra runbook 05); production = Supabase, on the owner's word,
-- through mumate-infra bin/prod-sql.sh, before the release that needs it.
-- subscriber_id is ManyChat's contact id, not a MuMate member; no message text is stored.
CREATE TABLE IF NOT EXISTS ebook_bot_event (
  id            bigserial   PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  env           text        NOT NULL CHECK (env IN ('staging', 'production', 'development')),
  subscriber_id text        NOT NULL CHECK (subscriber_id ~ '^[0-9]{1,20}$'),
  step          text        NOT NULL CHECK (step ~ '^[a-z0-9_]{1,40}$'),
  outcome       text        NOT NULL CHECK (outcome IN ('received', 'blocked', 'replied', 'reply_failed')),
  detail        jsonb       NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS ebook_bot_event_at_idx ON ebook_bot_event (at DESC);
CREATE INDEX IF NOT EXISTS ebook_bot_event_subscriber_idx ON ebook_bot_event (subscriber_id, at DESC);
