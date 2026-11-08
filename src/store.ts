// Where events go. Production is the MuMate Supabase database, staging its pgstaging copy (mumate-infra runbook 05).
// The table is created by migrations/0001_ebook_bot_event.sql, applied by hand like the app's other migrations.

import { SQL } from "bun";

export type Outcome = "received" | "blocked" | "replied" | "reply_failed";

export interface BotEvent {
  env: string;
  subscriberId: string;
  step: string;
  outcome: Outcome;
  detail?: Record<string, unknown>;
}

export interface Store {
  record(event: BotEvent): Promise<void>;
  ping(timeoutMs: number): Promise<boolean>;
  close(): Promise<void>;
}

export function createPgStore(url: string): Store {
  // A small pool: this app makes a handful of writes per chat message.
  const sql = new SQL({ url, max: 3, idleTimeout: 30, connectionTimeout: 5 });
  return {
    async record(e) {
      await sql`
        INSERT INTO ebook_bot_event (env, subscriber_id, step, outcome, detail)
        VALUES (${e.env}, ${e.subscriberId}, ${e.step}, ${e.outcome}, ${e.detail ?? {}})`;
    },
    async ping(timeoutMs) {
      // Bounded well below the container healthcheck timeout, so a slow database reads as unhealthy, not as a hung probe.
      const timeout = new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs));
      const query = sql`SELECT 1`.then(() => true as const).catch(() => false as const);
      return Promise.race([query, timeout]);
    },
    async close() {
      await sql.close();
    },
  };
}

export function createMemoryStore(): Store & { events: BotEvent[]; healthy: boolean } {
  const store = {
    events: [] as BotEvent[],
    healthy: true,
    async record(e: BotEvent) {
      store.events.push(e);
    },
    async ping() {
      return store.healthy;
    },
    async close() {},
  };
  return store;
}
