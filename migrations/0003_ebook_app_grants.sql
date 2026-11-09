-- 0003 — what the app's own login role may touch (CIEL mumate-manychat-ebook-001 slice 3).
-- On production the app logs in as ebook_app, made by mumate-infra bin/db-role.sh with no privilege at all; this file
-- is the only place its rights are written. It can read and write this app's three tables and nothing else: no member,
-- payment or app table, no DELETE, no DDL. Staging has no ebook_app role (the app uses pgstaging's owner), so there this
-- is a no-op. Idempotent: GRANT twice is the same as once.
-- Apply BY HAND after 0001 and 0002: production = Supabase, on the owner's word, through mumate-infra bin/prod-sql.sh.
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ebook_app') THEN
    GRANT USAGE ON SCHEMA public TO ebook_app;
    GRANT SELECT, INSERT ON ebook_bot_event TO ebook_app;
    GRANT SELECT, INSERT, UPDATE ON ebook_order TO ebook_app;
    GRANT SELECT, INSERT ON ebook_order_log TO ebook_app;
    GRANT USAGE, SELECT ON SEQUENCE ebook_bot_event_id_seq, ebook_order_id_seq, ebook_order_log_id_seq TO ebook_app;
  END IF;
END
$grants$;
