// Admin commands, run inside the container by mumate-infra bin/ebook.sh (docker compose exec ebook bun run src/cli.ts ...).
// Same config, database and ManyChat key as the server; no extra HTTP surface.
//
//   orders  [--hours N]                        recent orders (default 24 h)
//   pending [--hours N]                        orders that still need someone: retry, admin, rejected, paid-not-delivered
//   resend    <order-id> --by W --reason "…" [--dry-run]   send the delivery flow again to a paid order
//   mark-paid <order-id> --by W --reason "…" [--dry-run]   an admin confirmed the money: mark paid and deliver
//   mark-delivered <order-id> --by W --reason "…" [--dry-run]   an admin sent the E-Book by hand: close the order
//
// Output is pipe-separated lines. It never prints a subscriber id, an image link or a slip's sender name.

import { loadConfig } from "./config.ts";
import { createManyChat } from "./manychat.ts";
import { createNotifier } from "./notify.ts";
import { createProcessor } from "./orders.ts";
import { createPgOrderStore, type Order } from "./orders-store.ts";
import { createSlip2Go } from "./slip2go.ts";
import { openDatabase } from "./store.ts";

export function parseArgs(argv: string[]): { cmd: string; id?: number; hours: number; by?: string; reason?: string; dryRun: boolean } {
  const [cmd = "", ...rest] = argv;
  const out = { cmd, hours: 24, dryRun: false } as ReturnType<typeof parseArgs>;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--hours") out.hours = Number(rest[++i]);
    else if (a === "--by") out.by = rest[++i];
    else if (a === "--reason") out.reason = rest[++i];
    else if (/^\d+$/.test(a)) out.id = Number(a);
    else throw new Error(`unknown argument ${a}`);
  }
  if (!Number.isFinite(out.hours) || out.hours <= 0 || out.hours > 24 * 90) throw new Error("--hours must be 1..2160");
  return out;
}

export function orderLine(o: Order): string {
  const delivered = o.status === "paid" ? (o.deliveredAt ? "delivered" : "NOT delivered") : "-";
  const when = o.createdAt.toISOString().replace(/\.\d+Z$/, "Z");
  return [`order ${o.id}`, when, o.status, delivered, o.amount ?? "-", o.slipCode ?? "-", o.reason ?? "-",
    o.status === "retry" ? `attempts ${o.attempts}` : ""].join("|").replace(/\|$/, "");
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const sql = openDatabase(config.databaseUrl);
  const orders = createPgOrderStore(sql);
  try {
    if (args.cmd === "orders" || args.cmd === "pending") {
      const list = args.cmd === "orders"
        ? await orders.list(config.env, { sinceHours: args.hours })
        : (await orders.list(config.env, { sinceHours: args.hours }))
            .filter((o) => o.status !== "paid" || !o.deliveredAt);
      console.log(`where|${config.env}`);
      console.log(`${args.cmd}|${list.length} in the last ${args.hours} h`);
      for (const o of list) console.log(orderLine(o));
      return 0;
    }
    if (args.cmd === "resend" || args.cmd === "mark-paid" || args.cmd === "mark-delivered") {
      if (!config.slip) return fail("slip check is not configured on this host");
      if (!args.id) return fail(`${args.cmd} needs an order id`);
      if (!args.by || !args.reason?.trim()) return fail(`${args.cmd} needs --by and --reason`);
      const processor = createProcessor({
        env: config.env, slip: config.slip, slip2go: createSlip2Go(config.slip), orders,
        manychat: createManyChat({ apiKey: config.manychatApiKey, apiBase: config.manychatApiBase }), log: () => {},
        notifier: createNotifier({ webhook: config.discordWebhook, log: () => {} }),
      });
      const r = args.cmd === "resend"
        ? await processor.resend(args.id, args.by, args.reason, args.dryRun)
        : args.cmd === "mark-paid"
          ? await processor.markPaid(args.id, args.by, args.reason, args.dryRun)
          : await processor.markDelivered(args.id, args.by, args.reason, args.dryRun);
      console.log(`${args.dryRun ? "dry-run" : "result"}|${r.ok ? "ok" : "failed"}|${r.detail}`);
      return r.ok ? 0 : 1;
    }
    return fail("usage: orders|pending [--hours N] · resend|mark-paid|mark-delivered <id> --by W --reason \"…\" [--dry-run]", 2);
  } finally {
    await sql.close();
  }
}

function fail(message: string, code = 1): number {
  console.log(`result|failed|${message}`);
  return code;
}

if (import.meta.main) {
  main().then((code) => process.exit(code), (error) => {
    console.log(`result|failed|${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
