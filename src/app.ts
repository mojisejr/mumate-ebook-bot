// HTTP surface. Everything lives under /ebook-api/ because Caddy routes that path on the existing hosts to this app.
//
//   GET  /ebook-api/health          liveness + database reachability, for the container healthcheck and ops-status
//   POST /ebook-api/manychat/hook   ManyChat External Request. Answers at once, then does the work in the background:
//                                   ManyChat waits only about 10 s, and a late answer leaves the flow with empty fields.

import { timingSafeEqual } from "node:crypto";
import { mayMessage, type Config } from "./config.ts";
import type { ManyChat } from "./manychat.ts";
import type { Store } from "./store.ts";

export interface Deps {
  config: Pick<Config, "env" | "hookSecret" | "allowlist" | "open" | "gitSha">;
  store: Store;
  manychat: ManyChat;
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
      if (!secretMatches(req.headers.get("x-ebook-hook-secret"), deps.config.hookSecret)) {
        return json({ error: "forbidden" }, 403);
      }
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json({ error: "body must be JSON" }, 400);
      }
      const hook = parseHook(body);
      if (!hook) return json({ error: "need subscriber_id (digits) and step (a-z0-9_)" }, 400);
      defer(handleHook(hook.subscriberId, hook.step));
      return json(EMPTY_DYNAMIC_REPLY);
    }
    return json({ error: "not found" }, 404);
  };
}
