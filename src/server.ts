import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createManyChat } from "./manychat.ts";
import { createPgStore } from "./store.ts";

const config = loadConfig();
const store = createPgStore(config.databaseUrl);
const manychat = createManyChat({ apiKey: config.manychatApiKey, apiBase: config.manychatApiBase });
const handler = createApp({ config, store, manychat });

const server = Bun.serve({ port: config.port, fetch: handler });
console.log(JSON.stringify({ msg: "listening", port: server.port, env: config.env, sha: config.gitSha,
  allowlist: config.allowlist.size, open: config.open }));

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    server.stop();
    await store.close();
    process.exit(0);
  });
}
