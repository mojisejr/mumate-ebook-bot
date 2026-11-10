import { createApp } from "./app.ts";
import { createPgFunnelStore } from "./funnel.ts";
import { loadConfig } from "./config.ts";
import { createManyChat } from "./manychat.ts";
import { createProcessor } from "./orders.ts";
import { createPgOrderStore } from "./orders-store.ts";
import { createSlip2Go } from "./slip2go.ts";
import { createPgStore, openDatabase } from "./store.ts";

const config = loadConfig();
const sql = openDatabase(config.databaseUrl);
const store = createPgStore(sql);
const manychat = createManyChat({ apiKey: config.manychatApiKey, apiBase: config.manychatApiBase });
const processor = config.slip
  ? createProcessor({ env: config.env, slip: config.slip, slip2go: createSlip2Go(config.slip), manychat, orders: createPgOrderStore(sql) })
  : null;
const handler = createApp({ config, store, manychat, processor, funnel: createPgFunnelStore(sql) });

const server = Bun.serve({ port: config.port, fetch: handler });
console.log(JSON.stringify({ msg: "listening", port: server.port, env: config.env, sha: config.gitSha,
  allowlist: config.allowlist.size, open: config.open, slip: config.slip ? { price: config.slip.price } : "not configured" }));

// Slips Slip2Go could not check yet (bank error, rate limit, outage) are retried from the database, so a restart
// resumes them. One tick a minute; ticks never overlap.
let ticking = false;
const retryTimer = processor
  ? setInterval(async () => {
      if (ticking) return;
      ticking = true;
      try {
        const n = await processor.retryDue();
        if (n) console.log(JSON.stringify({ msg: "retried", count: n, env: config.env }));
      } catch (error) {
        console.log(JSON.stringify({ msg: "retry_error", env: config.env, error: error instanceof Error ? error.message : String(error) }));
      } finally {
        ticking = false;
      }
    }, 60_000)
  : null;

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    if (retryTimer) clearInterval(retryTimer);
    server.stop();
    await store.close();
    process.exit(0);
  });
}
