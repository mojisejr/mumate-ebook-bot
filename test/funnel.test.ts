import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { createMemoryFunnelStore, FUNNEL_STEPS, parseFunnel } from "../src/funnel.ts";
import type { ManyChat } from "../src/manychat.ts";
import { createMemoryStore } from "../src/store.ts";

const SECRET = "s".repeat(40);
const OWNER = "1234567890";
const CUSTOMER = "9999999999";

function harness(opts: { funnel?: boolean } = {}) {
  const funnel = createMemoryFunnelStore();
  const sent: string[] = [];
  const manychat: ManyChat = {
    async sendText(id) { sent.push(id); return { ok: true }; },
    async sendFlow(id) { sent.push(id); return { ok: true }; },
    async addTag() { return { ok: true }; },
    async setField() { return { ok: true }; },
    async contactInfo() { return { name: null, chatUrl: null }; },
  };
  const pending: Promise<unknown>[] = [];
  const logs: Record<string, unknown>[] = [];
  const app = createApp({
    config: { env: "production", hookSecret: SECRET, allowlist: new Set([OWNER]), open: false, gitSha: "abc" },
    store: createMemoryStore(), manychat, funnel: opts.funnel === false ? null : funnel,
    defer: (w) => void pending.push(w), log: (e) => void logs.push(e),
  });
  const send = async (body: unknown, secret: string | null = SECRET) => {
    const res = await app(new Request("http://x/ebook-api/manychat/event", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(secret ? { "X-Ebook-Hook-Secret": secret } : {}) },
      body: JSON.stringify(body),
    }));
    await Promise.all(pending);
    return res;
  };
  return { funnel, sent, send, logs };
}

describe("funnel event endpoint", () => {
  test("a known step is recorded for any contact, answers at once with the empty ManyChat reply, and messages nobody", async () => {
    const h = harness();
    const res = await h.send({ subscriber_id: CUSTOMER, step: "buy" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: "v2", content: { messages: [] } });
    expect(h.funnel.events).toEqual([{ env: "production", subscriberId: CUSTOMER, step: "buy", value: null }]);
    expect(h.sent).toEqual([]);
  });

  test("steps with a value list keep the value; the FU1 reasons and the entry source are accepted", async () => {
    const h = harness();
    await h.send({ subscriber_id: CUSTOMER, step: "reason", value: "want_qr" });
    await h.send({ subscriber_id: Number(CUSTOMER), step: "entry", value: "comment" });
    expect(h.funnel.events.map((e) => [e.step, e.value])).toEqual([["reason", "want_qr"], ["entry", "comment"]]);
  });

  test.each([
    [{ subscriber_id: CUSTOMER, step: "checkout" }, "unknown step"],
    [{ subscriber_id: CUSTOMER, step: "reason", value: "too_expensive" }, "value not in the list"],
    [{ subscriber_id: CUSTOMER, step: "reason" }, "a step with values needs one"],
    [{ subscriber_id: CUSTOMER, step: "buy", value: "x" }, "a step without values takes none"],
    [{ subscriber_id: "abc", step: "buy" }, "subscriber id not digits"],
    [{ subscriber_id: CUSTOMER, step: "__proto__" }, "prototype key"],
  ])("refused with 400 and nothing recorded: %o (%s)", async (body) => {
    const h = harness();
    expect((await h.send(body)).status).toBe(400);
    expect(h.funnel.events).toEqual([]);
  });

  test("a wrong secret is 403 and records nothing", async () => {
    const h = harness();
    expect((await h.send({ subscriber_id: CUSTOMER, step: "buy" }, "x".repeat(40))).status).toBe(403);
    expect(h.funnel.events).toEqual([]);
  });

  test("no funnel store configured: 503", async () => {
    const h = harness({ funnel: false });
    expect((await h.send({ subscriber_id: CUSTOMER, step: "buy" })).status).toBe(503);
  });

  test("a database failure still answers 200 at once and is logged, never thrown at ManyChat", async () => {
    const h = harness();
    h.funnel.failing = true;
    expect((await h.send({ subscriber_id: CUSTOMER, step: "sample" })).status).toBe(200);
    expect(h.logs.some((l) => l.msg === "funnel_error" && l.step === "sample")).toBe(true);
  });

  test("the step list matches the migration's CHECK", async () => {
    const sql = await Bun.file(new URL("../migrations/0004_ebook_funnel_event.sql", import.meta.url)).text();
    const listed = sql.match(/step IN \(([^)]*)\)/)![1]!.match(/'([a-z_]+)'/g)!.map((s) => s.slice(1, -1));
    expect(listed.sort()).toEqual(Object.keys(FUNNEL_STEPS).sort());
    for (const values of Object.values(FUNNEL_STEPS)) for (const v of values) expect(v).toMatch(/^[a-z_]{1,20}$/);
  });

  test("parseFunnel treats an empty value as none", () => {
    expect(parseFunnel({ subscriber_id: CUSTOMER, step: "sample", value: "" })).toEqual({ subscriberId: CUSTOMER, step: "sample", value: null });
  });
});
