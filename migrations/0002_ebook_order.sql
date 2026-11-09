-- 0002 — ebook_order and ebook_order_log (CIEL mumate-manychat-ebook-001 slice 2): one row per slip a contact sends,
-- and an append-only trail of what happened to it (check, delivery, an admin's mark-paid with its reason).
-- ADDITIVE ONLY and idempotent: no DROP, no DELETE, safe to run again.
-- Apply BY HAND: staging = pgstaging on mumate-2 (mumate-infra runbook 05); production = Supabase, on the owner's word,
-- through mumate-infra bin/prod-sql.sh, before the release that needs it.
-- The slip image itself is not stored (plan 0.4); image_url is ManyChat's link, kept only so a retry can resend it.
CREATE TABLE IF NOT EXISTS ebook_order (
  id              bigserial   PRIMARY KEY,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  env             text        NOT NULL CHECK (env IN ('staging', 'production', 'development')),
  subscriber_id   text        NOT NULL CHECK (subscriber_id ~ '^[0-9]{1,20}$'),
  image_hash      text        NOT NULL CHECK (image_hash ~ '^[0-9a-f]{64}$'),
  image_url       text        NOT NULL,
  -- checking → paid | rejected | retry | admin ; paid → delivered when the delivery flow was sent
  status          text        NOT NULL DEFAULT 'checking'
                              CHECK (status IN ('checking', 'retry', 'paid', 'rejected', 'admin')),
  slip_code       text,
  reason          text,
  trans_ref       text,
  amount          numeric(12, 2),
  slip_at         timestamptz,
  sender_name     text,
  attempts        integer     NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  delivered_at    timestamptz,
  delivery_error  text
);
-- the same ManyChat request (same contact, same image) is one order
CREATE UNIQUE INDEX IF NOT EXISTS ebook_order_image_uq ON ebook_order (env, image_hash);
-- a slip pays for one order only: our second line after Slip2Go's checkDuplicate
CREATE UNIQUE INDEX IF NOT EXISTS ebook_order_trans_ref_uq ON ebook_order (env, trans_ref) WHERE trans_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS ebook_order_created_idx ON ebook_order (env, created_at DESC);
CREATE INDEX IF NOT EXISTS ebook_order_retry_idx ON ebook_order (env, next_attempt_at) WHERE status = 'retry';

CREATE TABLE IF NOT EXISTS ebook_order_log (
  id        bigserial   PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  order_id  bigint      NOT NULL REFERENCES ebook_order (id),
  action    text        NOT NULL CHECK (action ~ '^[a-z_]{1,40}$'),
  by_whom   text        NOT NULL,
  reason    text,
  detail    jsonb       NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS ebook_order_log_order_idx ON ebook_order_log (order_id, at);
