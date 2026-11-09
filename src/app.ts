// HTTP surface. Everything lives under /ebook-api/ because Caddy routes that path on the existing hosts to this app.
//
//   GET  /ebook-api/health          liveness + database reachability, for the container healthcheck and ops-status
//   POST /ebook-api/manychat/hook   ManyChat External Request. Answers at once, then does the work in the background:
//                                   ManyChat waits only about 10 s, and a late answer leaves the flow with empty fields.
//   POST /ebook-api/manychat/slip   The slip image of the [TEST] flow (slice 2): {subscriber_id, image_url}. Same secret,
//                                   same answer-at-once rule; the check and the delivery run in the background.

import { timingSafeEqual } from "node:crypto";
import { mayMessage, type Config } from "./config.ts";
import type { ManyChat } from "./manychat.ts";
import type { Processor } from "./orders.ts";
import type { Store } from "./store.ts";

export interface Deps {
  config: Pick<Config, "env" | "hookSecret" | "allowlist" | "open" | "gitSha">;
  store: Store;
  manychat: ManyChat;
  // null until every slip setting is configured (config.slip): the slip endpoint then answers 503 and records why
  processor?: Processor | null;
  // Background work is handed here so tests can wait for it; production just lets it run.
  defer?: (work: Promise<unknown>) => void;
  log?: (entry: Record<string, unknown>) => void;
}

const EMPTY_DYNAMIC_REPLY = { version: "v2", content: { messages: [] } };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function secretMatches(given: string | null, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseHook(body: unknown): { subscriberId: string; step: string } | null {
  if (typeof body !== "object" || body === null) return null;
  const { subscriber_id, step } = body as Record<string, unknown>;
  const id = typeof subscriber_id === "number" ? String(subscriber_id) : subscriber_id;
  if (typeof id !== "string" || !/^\d{1,20}$/.test(id)) return null;
  if (typeof step !== "string" || !/^[a-z0-9_]{1,40}$/.test(step)) return null;
  return { subscriberId: id, step };
}

// ManyChat stores a received image as a link on its CDN; only https links are accepted, never anything local.
export function parseSlip(body: unknown): { subscriberId: string; imageUrl: string } | null {
  if (typeof body !== "object" || body === null) return null;
  const { subscriber_id, image_url } = body as Record<string, unknown>;
  const id = typeof subscriber_id === "number" ? String(subscriber_id) : subscriber_id;
  if (typeof id !== "string" || !/^\d{1,20}$/.test(id)) return null;
  if (typeof image_url !== "string" || image_url.length > 2000) return null;
  let url: URL;
  try {
    url = new URL(image_url.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  return { subscriberId: id, imageUrl: url.toString() };
}

export function createApp(deps: Deps): (req: Request) => Promise<Response> {
  const log = deps.log ?? ((entry) => console.log(JSON.stringify(entry)));
  const defer = deps.defer ?? ((work) => void work);

  async function handleHook(subscriberId: string, step: string): Promise<void> {
    const env = deps.config.env;
    try {
      await deps.store.record({ env, subscriberId, step, outcome: "received" });
      if (!mayMessage(deps.config, subscriberId)) {
        await deps.store.record({ env, subscriberId, step, outcome: "blocked", detail: { reason: "not in allowlist" } });
        log({ msg: "blocked", step, env });
        return;
      }
      const sent = await deps.manychat.sendText(subscriberId, `ระบบหลังบ้าน (${env}) ได้รับแล้ว · ขั้น ${step}`);
      if (sent.ok) {
        await deps.store.record({ env, subscriberId, step, outcome: "replied" });
      } else {
        await deps.store.record({ env, subscriberId, step, outcome: "reply_failed", detail: { error: sent.detail } });
        log({ msg: "reply_failed", step, env, error: sent.detail });
      }
    } catch (error) {
      log({ msg: "hook_error", step, env, error: error instanceof Error ? error.message : String(error) });
    }
  }

  async function handleSlip(subscriberId: string, imageUrl: string): Promise<void> {
    const env = deps.config.env;
    const step = "slip";
    try {
      await deps.store.record({ env, subscriberId, step, outcome: "received" });
      if (!mayMessage(deps.config, subscriberId)) {
        await deps.store.record({ env, subscriberId, step, outcome: "blocked", detail: { reason: "not in allowlist" } });
        log({ msg: "blocked", step, env });
        return;
      }
      if (!deps.processor) {
        await deps.store.record({ env, subscriberId, step, outcome: "reply_failed", detail: { error: "slip check not configured" } });
        log({ msg: "slip_not_configured", env });
        return;
      }
      const { order, created } = await deps.processor.handleSlip(subscriberId, imageUrl);
      log({ msg: created ? "slip_checked" : "slip_repeat", order: order.id, env });
    } catch (error) {
      log({ msg: "slip_error", env, error: error instanceof Error ? error.message : String(error) });
    }
  }

  async function readAuthorized(req: Request): Promise<{ body: unknown } | Response> {
    if (!secretMatches(req.headers.get("x-ebook-hook-secret"), deps.config.hookSecret)) {
      return json({ error: "forbidden" }, 403);
    }
    try {
      return { body: await req.json() };
    } catch {
      return json({ error: "body must be JSON" }, 400);
    }
  }

  return async (req) => {
    const url = new URL(req.url);
    // health = the process serves (Docker's healthcheck). It must not depend on the database: deploy.sh waits for
    // every running container, so a database outage here would roll back an unrelated fe or bazi deploy.
    // ready = the database answers too (checked by the ebook follower after its own deploy, and by ops tools).
    if (req.method === "GET" && (url.pathname === "/ebook-api/health" || url.pathname === "/ebook-api/ready")) {
      const db = await deps.store.ping(1000);
      const body = { ok: db, db: db ? "ok" : "down", env: deps.config.env, sha: deps.config.gitSha };
      return json(body, url.pathname.endsWith("/ready") && !db ? 503 : 200);
    }
    if (req.method === "POST" && url.pathname === "/ebook-api/manychat/hook") {
      const read = await readAuthorized(req);
      if (read instanceof Response) return read;
      const hook = parseHook(read.body);
      if (!hook) return json({ error: "need subscriber_id (digits) and step (a-z0-9_)" }, 400);
      defer(handleHook(hook.subscriberId, hook.step));
      return json(EMPTY_DYNAMIC_REPLY);
    }
    if (req.method === "POST" && url.pathname === "/ebook-api/manychat/slip") {
      const read = await readAuthorized(req);
      if (read instanceof Response) return read;
      const slip = parseSlip(read.body);
      if (!slip) return json({ error: "need subscriber_id (digits) and image_url (https)" }, 400);
      defer(handleSlip(slip.subscriberId, slip.imageUrl));
      return json(EMPTY_DYNAMIC_REPLY);
    }
    return json({ error: "not found" }, 404);
  };
}
