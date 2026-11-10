// The Postgres order store against a real, throwaway database. Skipped unless EBOOK_TEST_PG_URL points at one:
//   docker run --rm -d --name ebook-pg-test -e POSTGRES_PASSWORD=t -p 55432:5432 postgres:16-alpine
//   EBOOK_TEST_PG_URL=postgres://postgres:t@127.0.0.1:55432/postgres bun test test/pg.test.ts
// Never point it at staging or production: it creates the tables and writes test rows.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createPgFunnelStore } from "../src/funnel.ts";
import { createPgOrderStore } from "../src/orders-store.ts";
import { createPgStore, openDatabase } from "../src/store.ts";

const url = process.env.EBOOK_TEST_PG_URL;
const local = url && /@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url);

describe.skipIf(!local)("postgres order store", () => {
  test("migrations apply twice, and every guarded update holds", async () => {
    const sql = openDatabase(url!);
    try {
      for (const f of ["0001_ebook_bot_event.sql", "0002_ebook_order.sql", "0003_ebook_app_grants.sql", "0004_ebook_funnel_event.sql"]) {
        const text = readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8");
        await sql.unsafe(text);
        await sql.unsafe(text); // idempotent
      }
      const env = `development`;
      const tag = Date.now().toString(16);
      const h = (n: number) => (tag + String(n)).padEnd(64, "0").slice(0, 64).replace(/[^0-9a-f]/g, "0");
      const orders = createPgOrderStore(sql);
      const a = await orders.open({ env, subscriberId: "1234567890", imageHash: h(1), imageUrl: "https://x/1" });
      expect(a.created).toBe(true);
      const again = await orders.open({ env, subscriberId: "1234567890", imageHash: h(1), imageUrl: "https://x/1" });
      expect(again).toMatchObject({ created: false, order: { id: a.order.id } });

      const ref = `REF${tag}`;
      expect(await orders.claimTransRef(a.order.id, ref)).toBe(true);
      expect(await orders.claimTransRef(a.order.id, ref)).toBe(true); // same order, same slip: still its own
      const b = await orders.open({ env, subscriberId: "1234567890", imageHash: h(2), imageUrl: "https://x/2" });
      expect(await orders.claimTransRef(b.order.id, ref)).toBe(false); // the unique index refuses a second owner

      expect(await orders.claimDelivery(a.order.id)).toBe(false); // not paid yet
      await orders.setResult(a.order.id, { status: "paid", slipCode: "200200", amount: 1, slipAt: "2026-11-09T04:00:00.000Z", senderName: "x" });
      expect(await orders.claimDelivery(a.order.id)).toBe(true);
      expect(await orders.claimDelivery(a.order.id)).toBe(false); // exactly once
      await orders.deliveryFailed(a.order.id, "sendFlow failed");
      expect(await orders.claimDelivery(a.order.id)).toBe(true); // a failed send can be claimed again by resend

      const due = new Date(Date.now() - 1000);
      await orders.setResult(b.order.id, { status: "retry", slipCode: "200502", reason: "bank", attempts: 1, nextAttemptAt: due });
      expect((await orders.dueRetries(env, new Date())).map((o) => o.id)).toContain(b.order.id);
      expect((await orders.get(a.order.id))).toMatchObject({ status: "paid", amount: 1, transRef: ref });
      expect((await orders.list(env, { sinceHours: 1 })).length).toBeGreaterThanOrEqual(2);
      await orders.log({ orderId: a.order.id, action: "mark_paid", by: "test", reason: "r", detail: { k: 1 } });

      await createPgStore(sql).record({ env, subscriberId: "1234567890", step: "slip", outcome: "received" });
    } finally {
      await sql.close();
    }
  });

  test("0003: ebook_app reads and writes only this app's tables, and cannot delete", async () => {
    const admin = openDatabase(url!);
    const pw = `t${Date.now().toString(16)}`;
    try {
      await admin.unsafe(`DO $r$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ebook_app') THEN CREATE ROLE ebook_app LOGIN NOINHERIT; END IF; END $r$`);
      await admin.unsafe(`ALTER ROLE ebook_app PASSWORD '${pw}'`);
      await admin.unsafe("CREATE TABLE IF NOT EXISTS not_ebook_member (id int)");
      for (const f of ["0001_ebook_bot_event.sql", "0002_ebook_order.sql", "0003_ebook_app_grants.sql", "0004_ebook_funnel_event.sql"]) {
        await admin.unsafe(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
      }
    } finally {
      await admin.close();
    }
    const asApp = openDatabase(url!.replace(/\/\/[^@]+@/, `//ebook_app:${pw}@`));
    try {
      const orders = createPgOrderStore(asApp);
      const tag = Date.now().toString(16).padEnd(64, "0").slice(0, 64);
      const o = await orders.open({ env: "development", subscriberId: "1234567890", imageHash: tag, imageUrl: "https://x/3" });
      await orders.setResult(o.order.id, { status: "paid", slipCode: "200200", amount: 1 });
      expect(await orders.claimDelivery(o.order.id)).toBe(true);
      await orders.log({ orderId: o.order.id, action: "test", by: "test" });
      await createPgStore(asApp).record({ env: "development", subscriberId: "1234567890", step: "slip", outcome: "received" });
      await createPgFunnelStore(asApp).record({ env: "development", subscriberId: "1234567890", step: "reason", value: "want_qr" });
      const [row] = await asApp`SELECT step, value FROM ebook_funnel_event ORDER BY id DESC LIMIT 1`;
      expect(row).toMatchObject({ step: "reason", value: "want_qr" });
      await expect(asApp`INSERT INTO ebook_funnel_event (env, subscriber_id, step) VALUES ('development', '1', 'checkout')`.then(() => "inserted")).rejects.toThrow(/check constraint/);
      await expect(asApp`DELETE FROM ebook_funnel_event`.then(() => "deleted")).rejects.toThrow(/permission denied/);
      await expect(asApp`SELECT * FROM not_ebook_member`.then(() => "read")).rejects.toThrow(/permission denied/);
      await expect(asApp`DELETE FROM ebook_order WHERE id = ${o.order.id}`.then(() => "deleted")).rejects.toThrow(/permission denied/);
      await expect(asApp`CREATE TABLE ebook_app_made (id int)`.then(() => "created")).rejects.toThrow(/permission denied/);

    } finally {
      await asApp.close();
    }
  });
});
