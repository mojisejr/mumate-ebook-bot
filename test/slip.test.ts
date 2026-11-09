import { describe, expect, test } from "bun:test";
import { createApp, parseSlip } from "../src/app.ts";
import { parseArgs } from "../src/cli.ts";
import { loadConfig, type SlipConfig } from "../src/config.ts";
import type { ManyChat, Sent } from "../src/manychat.ts";
import { createProcessor, MAX_ATTEMPTS, reasonText } from "../src/orders.ts";
import { createMemoryOrderStore } from "../src/orders-store.ts";
import { classify, createSlip2Go, type Slip2Go, type Verdict } from "../src/slip2go.ts";
import { createMemoryStore } from "../src/store.ts";

const SECRET = "s".repeat(40);
const TESTER = "1234567890";
const STRANGER = "9999999999";
const IMG = "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1&signature=x";
const SLIP: SlipConfig = {
  apiUrl: "https://s2g.test", secretKey: "KEY", receiverAccountType: "01004", receiverAccountNumber: "2008204872",
  price: 1, flowDeliver: "content20261109120000_111111", flowNotice: "content20261109120000_222222",
};
const slipData = (transRef = "016313103525CTF05846") => ({ transRef, amount: 1, dateTime: "2026-11-09T04:00:00.000Z", sender: { account: { name: { th: "นาย ทดสอบ" } } } });

// Answers recorded from the Slip2Go dashboard's Response page (2026-11-09); the service is never called in tests.
function answers(...codes: (string | Verdict)[]): Slip2Go & { calls: number } {
  const queue = [...codes];
  const s = {
    calls: 0,
    async verifyImageLink() {
      s.calls++;
      const next = queue.shift() ?? "200200";
      return typeof next === "string" ? classify(next, slipData()) : next;
    },
  };
  return s;
}

function fakeManyChat(fail: Partial<Record<keyof ManyChat, boolean>> = {}) {
  const calls: string[] = [];
  const reply = (name: keyof ManyChat, what: string): Sent => {
    calls.push(what);
    return fail[name] ? { ok: false, detail: `${name} failed` } : { ok: true };
  };
  const mc: ManyChat & { calls: string[] } = {
    calls,
    async sendText(_id, text) { return reply("sendText", `text:${text}`); },
    async sendFlow(_id, ns) { return reply("sendFlow", `flow:${ns}`); },
    async addTag(_id, tag) { return reply("addTag", `tag:${tag}`); },
    async setField(_id, name, value) { return reply("setField", `field:${name}=${value}`); },
  };
  return mc;
}

function harness(opts: { slip2go?: Slip2Go & { calls: number }; mc?: ReturnType<typeof fakeManyChat>; configured?: boolean; now?: () => Date } = {}) {
  const orders = createMemoryOrderStore();
  const mc = opts.mc ?? fakeManyChat();
  const slip2go = opts.slip2go ?? answers();
  const logs: Record<string, unknown>[] = [];
  const processor = createProcessor({ env: "staging", slip: SLIP, slip2go, manychat: mc, orders, now: opts.now, log: (e) => void logs.push(e) });
  const store = createMemoryStore();
  const pending: Promise<unknown>[] = [];
  const app = createApp({
    config: { env: "staging", hookSecret: SECRET, allowlist: new Set([TESTER]), open: false, gitSha: "abc" },
    store, manychat: mc, processor: opts.configured === false ? null : processor,
    defer: (w) => void pending.push(w), log: () => {},
  });
  const send = async (body: unknown, secret: string | null = SECRET) => {
    const res = await app(new Request("http://x/ebook-api/manychat/slip", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(secret ? { "X-Ebook-Hook-Secret": secret } : {}) },
      body: JSON.stringify(body),
    }));
    await Promise.all(pending);
    return res;
  };
  const deliveries = () => mc.calls.filter((c) => c === `flow:${SLIP.flowDeliver}`).length;
  const notices = () => mc.calls.filter((c) => c === `flow:${SLIP.flowNotice}`).length;
  return { orders, mc, slip2go, processor, store, send, deliveries, notices, logs };
}

describe("slip endpoint", () => {
  test("a valid slip (200200) is paid and delivered once: tag bot_paid, then the delivery flow", async () => {
    const h = harness();
    const res = await h.send({ subscriber_id: TESTER, image_url: IMG });
    expect(await res.json()).toEqual({ version: "v2", content: { messages: [] } });
    expect(h.orders.orders[0]).toMatchObject({ status: "paid", transRef: "016313103525CTF05846", amount: 1 });
    expect(h.orders.orders[0]!.deliveredAt).not.toBeNull();
    expect(h.mc.calls).toEqual(["tag:bot_paid", `flow:${SLIP.flowDeliver}`]);
  });

  test("the same ManyChat request again delivers nothing more and does not call Slip2Go again", async () => {
    const h = harness();
    await h.send({ subscriber_id: TESTER, image_url: IMG });
    await h.send({ subscriber_id: TESTER, image_url: IMG });
    expect(h.deliveries()).toBe(1);
    expect(h.slip2go.calls).toBe(1);
    expect(h.orders.logs.map((l) => l.action)).toContain("repeat_request");
  });

  test("a slip that already paid, sent again as a new image, is refused by our table even if Slip2Go passed it", async () => {
    const h = harness();
    await h.send({ subscriber_id: TESTER, image_url: IMG });
    await h.send({ subscriber_id: TESTER, image_url: IMG + "&again=1" });
    expect(h.deliveries()).toBe(1);
    expect(h.orders.orders[1]).toMatchObject({ status: "rejected", reason: "duplicate (our table)" });
    expect(h.mc.calls).toContain(`field:bot_reason=${reasonText("duplicate", 1)}`);
  });

  test("200000 (found, conditions not checked) never pays", async () => {
    const h = harness({ slip2go: answers("200000") });
    await h.send({ subscriber_id: TESTER, image_url: IMG });
    expect(h.deliveries()).toBe(0);
    expect(h.orders.orders[0]!.status).toBe("admin");
    expect(h.notices()).toBe(1);
  });

  test.each([
    ["200401", "receiver"], ["200402", "amount"], ["200404", "not_found"], ["200500", "fraud"], ["200501", "duplicate"],
    ["400001", "not_a_slip"], ["400004", "not_a_slip"],
  ] as const)("%s is refused with a reason in plain words, tag bot_rejected, the notice flow, nothing delivered", async (code, reason) => {
    const h = harness({ slip2go: answers(code) });
    await h.send({ subscriber_id: TESTER, image_url: IMG });
    expect(h.orders.orders[0]).toMatchObject({ status: "rejected", reason, slipCode: code });
    expect(h.mc.calls).toEqual([`field:bot_reason=${reasonText(reason, 1)}`, "tag:bot_rejected", `flow:${SLIP.flowNotice}`]);
    expect(h.deliveries()).toBe(0);
  });

  test("the amount reason names this host's price", () => {
    expect(reasonText("amount", 95)).toContain("95 บาท");
  });

  test.each(["200502", "429000", "500500", "500503"])("%s backs off and retries, then delivers when Slip2Go passes", async (code) => {
    let t = new Date("2026-11-09T05:00:00Z");
    const h = harness({ slip2go: answers(code, "200200"), now: () => t });
    await h.send({ subscriber_id: TESTER, image_url: IMG });
    expect(h.orders.orders[0]).toMatchObject({ status: "retry", attempts: 1 });
    expect(h.mc.calls).toEqual([]);
    expect(await h.processor.retryDue()).toBe(0); // not due yet
    t = new Date(t.getTime() + 61_000);
    expect(await h.processor.retryDue()).toBe(1);
    expect(h.orders.orders[0]!.status).toBe("paid");
    expect(h.deliveries()).toBe(1);
  });

  test(`a network failure is a retry too, and after ${MAX_ATTEMPTS} failures the admin takes over with an alert`, async () => {
    let t = new Date("2026-11-09T05:00:00Z");
    const down: Verdict = { kind: "retry", code: "network", detail: "ECONNRESET" };
    const h = harness({ slip2go: answers(down, down, down, down, down), now: () => t });
    await h.send({ subscriber_id: TESTER, image_url: IMG });
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      t = new Date(t.getTime() + 60 * 60_000);
      await h.processor.retryDue();
    }
    expect(h.orders.orders[0]!.status).toBe("admin");
    expect(h.slip2go.calls).toBe(MAX_ATTEMPTS);
    expect(h.notices()).toBe(1);
    expect(h.mc.calls).toContain("tag:bot_admin");
    expect(h.logs.some((l) => l.msg === "alert")).toBe(true);
  });

  test.each(["401001", "401005", "401007"])("%s (our account) goes to the admin with an alert", async (code) => {
    const h = harness({ slip2go: answers(code) });
    await h.send({ subscriber_id: TESTER, image_url: IMG });
    expect(h.orders.orders[0]!.status).toBe("admin");
    expect(h.mc.calls).toContain(`field:bot_reason=${reasonText("admin", 1)}`);
    expect(h.logs.some((l) => l.msg === "alert")).toBe(true);
  });

  test("an unknown code goes to the admin without paying", async () => {
    const h = harness({ slip2go: answers("299999") });
    await h.send({ subscriber_id: TESTER, image_url: IMG });
    expect(h.orders.orders[0]!.status).toBe("admin");
    expect(h.deliveries()).toBe(0);
  });

  test("a stranger is blocked before any order exists", async () => {
    const h = harness();
    await h.send({ subscriber_id: STRANGER, image_url: IMG });
    expect(h.orders.orders).toEqual([]);
    expect(h.mc.calls).toEqual([]);
    expect(h.store.events.map((e) => e.outcome)).toEqual(["received", "blocked"]);
  });

  test("not configured: no order, no message, the event says why", async () => {
    const h = harness({ configured: false });
    await h.send({ subscriber_id: TESTER, image_url: IMG });
    expect(h.mc.calls).toEqual([]);
    expect(h.store.events.at(-1)).toMatchObject({ outcome: "reply_failed", detail: { error: "slip check not configured" } });
  });

  test("wrong secret and bad bodies are refused before anything happens", async () => {
    const h = harness();
    expect((await h.send({ subscriber_id: TESTER, image_url: IMG }, "x".repeat(40))).status).toBe(403);
    expect((await h.send({ subscriber_id: TESTER, image_url: "http://insecure/x.jpg" })).status).toBe(400);
    expect((await h.send({ subscriber_id: TESTER })).status).toBe(400);
    expect(h.orders.orders).toEqual([]);
  });

  test("parseSlip accepts https only", () => {
    expect(parseSlip({ subscriber_id: 1234567890, image_url: IMG })?.subscriberId).toBe(TESTER);
    expect(parseSlip({ subscriber_id: TESTER, image_url: "file:///etc/passwd" })).toBeNull();
    expect(parseSlip({ subscriber_id: TESTER, image_url: "not a url" })).toBeNull();
  });
});

describe("delivery failures and admin commands", () => {
  test("a failed delivery stays paid-not-delivered and resend delivers it", async () => {
    const mc = fakeManyChat({ sendFlow: true });
    const h = harness({ mc });
    await h.send({ subscriber_id: TESTER, image_url: IMG });
    const id = h.orders.orders[0]!.id;
    expect(h.orders.orders[0]).toMatchObject({ status: "paid", deliveredAt: null, deliveryError: "sendFlow failed" });
    mc.calls.length = 0;
    // fix ManyChat, then resend
    (mc as { sendFlow: ManyChat["sendFlow"] }).sendFlow = async (_id, ns) => { mc.calls.push(`flow:${ns}`); return { ok: true }; };
    expect(await h.processor.resend(id, "owner", "first send failed", true)).toMatchObject({ ok: true });
    expect(h.deliveries()).toBe(0); // dry run sends nothing
    expect(await h.processor.resend(id, "owner", "first send failed", false)).toEqual({ ok: true, detail: "delivered" });
    expect(h.deliveries()).toBe(1);
    expect(h.orders.logs.find((l) => l.action === "resend")).toMatchObject({ by: "owner", reason: "first send failed" });
  });

  test("mark-paid delivers a refused order and records who and why; dry-run changes nothing", async () => {
    const h = harness({ slip2go: answers("200404") });
    await h.send({ subscriber_id: TESTER, image_url: IMG });
    const id = h.orders.orders[0]!.id;
    expect(await h.processor.markPaid(id, "owner", "money seen in KBank", true)).toMatchObject({ ok: true });
    expect(h.orders.orders[0]!.status).toBe("rejected");
    expect(await h.processor.markPaid(id, "owner", "money seen in KBank", false)).toEqual({ ok: true, detail: "delivered" });
    expect(h.orders.orders[0]!.status).toBe("paid");
    expect(h.deliveries()).toBe(1);
    expect(h.orders.logs.find((l) => l.action === "mark_paid")).toMatchObject({ by: "owner", reason: "money seen in KBank" });
    expect(await h.processor.markPaid(id, "owner", "again", false)).toMatchObject({ ok: false });
    expect(h.deliveries()).toBe(1);
  });

  test("resend refuses an order that is not paid", async () => {
    const h = harness({ slip2go: answers("200402") });
    await h.send({ subscriber_id: TESTER, image_url: IMG });
    expect(await h.processor.resend(1, "owner", "x", false)).toMatchObject({ ok: false });
    expect(h.deliveries()).toBe(0);
  });

  test("cli arguments", () => {
    expect(parseArgs(["mark-paid", "12", "--by", "owner", "--reason", "seen", "--dry-run"]))
      .toEqual({ cmd: "mark-paid", id: 12, hours: 24, by: "owner", reason: "seen", dryRun: true });
    expect(() => parseArgs(["orders", "--hours", "0"])).toThrow();
    expect(() => parseArgs(["orders", "--bogus"])).toThrow();
  });
});

describe("Slip2Go client", () => {
  test("sends the image link with checkDuplicate, bank+number receiver (no name) and the exact amount", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const s = createSlip2Go({ ...SLIP, price: 95 }, {
      fetch: async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ code: "200200", message: "Slip is valid", data: slipData() })); },
    });
    expect(await s.verifyImageLink(IMG)).toMatchObject({ kind: "pass", slip: { transRef: "016313103525CTF05846", senderName: "นาย ทดสอบ" } });
    expect(calls[0]!.url).toBe("https://s2g.test/api/verify-slip/qr-image-link/info");
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe("Bearer KEY");
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({
      payload: {
        imageUrl: IMG,
        checkCondition: {
          checkDuplicate: true,
          checkReceiver: [{ accountType: "01004", accountNumber: "2008204872" }],
          checkAmount: { type: "eq", amount: "95" },
        },
      },
    });
  });

  test("reads the code on an HTTP error too, and treats outages as retries", async () => {
    const at = (status: number, body: string) =>
      createSlip2Go(SLIP, { fetch: async () => new Response(body, { status }) }).verifyImageLink(IMG);
    expect(await at(401, JSON.stringify({ code: "401007", message: "IP Address not Allowed" }))).toMatchObject({ kind: "admin", alert: true });
    expect(await at(429, JSON.stringify({ code: "429000" }))).toMatchObject({ kind: "retry" });
    expect(await at(502, "<html>bad gateway</html>")).toMatchObject({ kind: "retry" });
    expect(await at(400, JSON.stringify({ code: "400004" }))).toMatchObject({ kind: "reject", reason: "not_a_slip" });
    const down = createSlip2Go(SLIP, { fetch: async () => { throw new Error("ETIMEDOUT"); } });
    expect(await down.verifyImageLink(IMG)).toMatchObject({ kind: "retry", code: "network" });
  });
});

describe("slip config", () => {
  const base = { MUMATE_ENV: "staging", EBOOK_HOOK_SECRET: SECRET, EBOOK_DATABASE_URL: "postgres://u@h/db", MANYCHAT_API_KEY: "k" };
  const slip = {
    SLIP2GO_SECRET_KEY: "KEY", EBOOK_RECEIVER_ACCOUNT_TYPE: "01004", EBOOK_RECEIVER_ACCOUNT_NUMBER: "2008204872",
    EBOOK_PRICE: "1", EBOOK_FLOW_DELIVER: SLIP.flowDeliver, EBOOK_FLOW_NOTICE: SLIP.flowNotice,
  };
  test("absent = slice 1 behaviour; complete = configured with the default API URL", () => {
    expect(loadConfig(base).slip).toBeNull();
    expect(loadConfig({ ...base, ...slip }).slip).toMatchObject({ apiUrl: "https://connect.slip2go.com", price: 1 });
  });
  test("half configured or malformed values stop the start", () => {
    expect(() => loadConfig({ ...base, SLIP2GO_SECRET_KEY: "KEY" })).toThrow("half configured");
    expect(() => loadConfig({ ...base, ...slip, EBOOK_PRICE: "95.-" })).toThrow("EBOOK_PRICE");
    expect(() => loadConfig({ ...base, ...slip, EBOOK_RECEIVER_ACCOUNT_NUMBER: "200-8-20487-2" })).toThrow("digits");
    expect(() => loadConfig({ ...base, ...slip, EBOOK_FLOW_DELIVER: "my flow" })).toThrow("flow ns");
  });
});
