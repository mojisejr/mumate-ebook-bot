import { describe, expect, test } from "bun:test";
import { createApp, parseHook } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { ManyChat } from "../src/manychat.ts";
import { createManyChat } from "../src/manychat.ts";
import { createMemoryStore } from "../src/store.ts";

const SECRET = "s".repeat(40);
const TESTER = "1234567890";
const STRANGER = "9999999999";

function harness(opts: { open?: boolean; sendOk?: boolean } = {}) {
  const store = createMemoryStore();
  const sent: { id: string; text: string }[] = [];
  const manychat: ManyChat = {
    async sendText(id, text) {
      sent.push({ id, text });
      return opts.sendOk === false ? { ok: false, detail: "HTTP 400: window closed" } : { ok: true };
    },
    async sendFlow() { return { ok: true }; },
    async addTag() { return { ok: true }; },
    async setField() { return { ok: true }; },
  };
  const pending: Promise<unknown>[] = [];
  const app = createApp({
    config: { env: "staging", hookSecret: SECRET, allowlist: new Set([TESTER]), open: opts.open ?? false, gitSha: "abc" },
    store,
    manychat,
    defer: (work) => void pending.push(work),
    log: () => {},
  });
  const hook = (body: unknown, secret: string | null = SECRET) =>
    app(new Request("http://x/ebook-api/manychat/hook", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(secret ? { "X-Ebook-Hook-Secret": secret } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }));
  const settle = () => Promise.all(pending);
  return { app, store, sent, hook, settle };
}

describe("hook", () => {
  test("answers ManyChat at once with an empty dynamic reply, then replies to an allowlisted tester", async () => {
    const h = harness();
    const res = await h.hook({ subscriber_id: TESTER, step: "hello" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: "v2", content: { messages: [] } });
    await h.settle();
    expect(h.sent).toEqual([{ id: TESTER, text: expect.stringContaining("hello") }]);
    expect(h.store.events.map((e) => e.outcome)).toEqual(["received", "replied"]);
  });

  test("never messages a subscriber outside the allowlist, and records that it refused", async () => {
    const h = harness();
    expect((await h.hook({ subscriber_id: STRANGER, step: "hello" })).status).toBe(200);
    await h.settle();
    expect(h.sent).toEqual([]);
    expect(h.store.events.map((e) => e.outcome)).toEqual(["received", "blocked"]);
  });

  test("records a failed send instead of throwing", async () => {
    const h = harness({ sendOk: false });
    await h.hook({ subscriber_id: TESTER, step: "hello" });
    await h.settle();
    expect(h.store.events.at(-1)).toMatchObject({ outcome: "reply_failed", detail: { error: "HTTP 400: window closed" } });
  });

  test("refuses a missing or wrong secret before reading anything", async () => {
    const h = harness();
    expect((await h.hook({ subscriber_id: TESTER, step: "hello" }, null)).status).toBe(403);
    expect((await h.hook({ subscriber_id: TESTER, step: "hello" }, "x".repeat(40))).status).toBe(403);
    await h.settle();
    expect(h.store.events).toEqual([]);
  });

  test("rejects malformed bodies", async () => {
    const h = harness();
    expect((await h.hook("not json")).status).toBe(400);
    expect((await h.hook({ subscriber_id: "12a", step: "hello" })).status).toBe(400);
    expect((await h.hook({ subscriber_id: TESTER, step: "DROP TABLE" })).status).toBe(400);
    await h.settle();
    expect(h.store.events).toEqual([]);
  });

  test("accepts a numeric subscriber_id as ManyChat may send it", () => {
    expect(parseHook({ subscriber_id: 1234567890, step: "hello" })).toEqual({ subscriberId: TESTER, step: "hello" });
  });
});

describe("health", () => {
  test("health stays 200 when the database is down (it must not block other apps' deploys); ready turns 503", async () => {
    const h = harness();
    const ok = await h.app(new Request("http://x/ebook-api/health"));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, sha: "abc", env: "staging" });
    expect((await h.app(new Request("http://x/ebook-api/ready"))).status).toBe(200);
    h.store.healthy = false;
    const down = await h.app(new Request("http://x/ebook-api/health"));
    expect(down.status).toBe(200);
    expect(await down.json()).toMatchObject({ ok: false, db: "down" });
    expect((await h.app(new Request("http://x/ebook-api/ready"))).status).toBe(503);
  });

  test("anything else is 404", async () => {
    expect((await harness().app(new Request("http://x/"))).status).toBe(404);
  });
});

describe("config", () => {
  const base = {
    MUMATE_ENV: "staging", EBOOK_HOOK_SECRET: SECRET, EBOOK_DATABASE_URL: "postgres://u@h/db", MANYCHAT_API_KEY: "k",
  };
  test("keeps only numeric ids in the allowlist", () => {
    expect([...loadConfig({ ...base, EBOOK_ALLOWLIST: ` ${TESTER}, abc ,,42` }).allowlist]).toEqual([TESTER, "42"]);
  });
  test("refuses EBOOK_OPEN outside production, a short secret, and missing values", () => {
    expect(() => loadConfig({ ...base, EBOOK_OPEN: "1" })).toThrow("production only");
    expect(() => loadConfig({ ...base, EBOOK_HOOK_SECRET: "short" })).toThrow("32");
    expect(() => loadConfig({ ...base, MANYCHAT_API_KEY: "" })).toThrow("MANYCHAT_API_KEY");
    expect(() => loadConfig({ ...base, MUMATE_ENV: "prod" })).toThrow("MUMATE_ENV");
  });
  test("is closed by default, even on production", () => {
    expect(loadConfig({ ...base, MUMATE_ENV: "production" }).open).toBe(false);
  });
});

describe("manychat client", () => {
  test("posts sendContent with the bearer key and reads success", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const mc = createManyChat({
      apiKey: "KEY", apiBase: "https://mc.test",
      fetch: async (url, init) => { calls.push({ url, init }); return new Response('{"status":"success"}'); },
    });
    expect(await mc.sendText(TESTER, "hi")).toEqual({ ok: true });
    expect(calls[0]?.url).toBe("https://mc.test/fb/sending/sendContent");
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe("Bearer KEY");
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({ subscriber_id: 1234567890 });
  });
  test("turns an error answer or a network failure into ok:false", async () => {
    const bad = createManyChat({ apiKey: "K", apiBase: "https://mc.test",
      fetch: async () => new Response('{"status":"error","message":"window"}', { status: 400 }) });
    expect(await bad.sendText(TESTER, "hi")).toMatchObject({ ok: false });
    const down = createManyChat({ apiKey: "K", apiBase: "https://mc.test", fetch: async () => { throw new Error("ECONNRESET"); } });
    expect(await down.sendText(TESTER, "hi")).toEqual({ ok: false, detail: "/fb/sending/sendContent ECONNRESET" });
  });
});
