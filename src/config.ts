// Every setting comes from the environment (mumate-infra places env/ebook.env on each host).
// A missing required value stops the process at start, so a half-configured app never answers ManyChat.

export type MumateEnv = "staging" | "production" | "development";

export interface Config {
  env: MumateEnv;
  port: number;
  databaseUrl: string;
  manychatApiKey: string;
  manychatApiBase: string;
  hookSecret: string;
  // Subscribers the app may message. Everywhere except production with EBOOK_OPEN=1, anyone else is refused:
  // ManyChat has one page and one key, so a bug on staging must never reach a real customer.
  allowlist: ReadonlySet<string>;
  open: boolean;
  gitSha: string;
  // Slice 2. Absent until every value is set: the app still answers the slice 1 hook, and the slip endpoint says
  // "not configured" instead of guessing a price or a receiver.
  slip: SlipConfig | null;
  /** the team's E-Book room in Discord (sale and "paid but not delivered" cards); null = post nothing */
  discordWebhook: string | null;
}

export interface SlipConfig {
  apiUrl: string;
  secretKey: string;
  receiverAccountType: string;
  receiverAccountNumber: string;
  price: number;
  // ManyChat flows the app sends: delivery (E-Book link, app coupon, how-to image) and notice ({{bot_reason}} + admin)
  flowDeliver: string;
  flowNotice: string;
}

const SLIP_KEYS = [
  "SLIP2GO_SECRET_KEY", "EBOOK_RECEIVER_ACCOUNT_TYPE", "EBOOK_RECEIVER_ACCOUNT_NUMBER", "EBOOK_PRICE",
  "EBOOK_FLOW_DELIVER", "EBOOK_FLOW_NOTICE",
] as const;

function loadSlip(env: Record<string, string | undefined>): SlipConfig | null {
  const present = SLIP_KEYS.filter((k) => env[k]?.trim());
  if (present.length === 0) return null;
  if (present.length < SLIP_KEYS.length) {
    const missing = SLIP_KEYS.filter((k) => !env[k]?.trim());
    throw new Error(`slip check is half configured; missing ${missing.join(", ")}`);
  }
  const price = Number(env.EBOOK_PRICE);
  if (!Number.isFinite(price) || price <= 0 || !/^\d+(\.\d{1,2})?$/.test(env.EBOOK_PRICE!.trim())) {
    throw new Error("EBOOK_PRICE must be a positive amount in baht, like 95 or 1");
  }
  const type = env.EBOOK_RECEIVER_ACCOUNT_TYPE!.trim();
  if (!/^\d{5}$/.test(type)) throw new Error("EBOOK_RECEIVER_ACCOUNT_TYPE must be a five-digit Slip2Go bank code");
  const number = env.EBOOK_RECEIVER_ACCOUNT_NUMBER!.trim();
  if (!/^\d{6,15}$/.test(number)) throw new Error("EBOOK_RECEIVER_ACCOUNT_NUMBER must be digits only");
  for (const k of ["EBOOK_FLOW_DELIVER", "EBOOK_FLOW_NOTICE"] as const) {
    if (!/^content\d{14}_\d{1,10}$/.test(env[k]!.trim())) throw new Error(`${k} must be a ManyChat flow ns like content20261109120000_123456`);
  }
  return {
    apiUrl: (env.SLIP2GO_API_URL?.trim() || "https://connect.slip2go.com").replace(/\/+$/, ""),
    secretKey: env.SLIP2GO_SECRET_KEY!.trim(),
    receiverAccountType: type,
    receiverAccountNumber: number,
    price,
    flowDeliver: env.EBOOK_FLOW_DELIVER!.trim(),
    flowNotice: env.EBOOK_FLOW_NOTICE!.trim(),
  };
}

function loadWebhook(raw: string | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  if (!/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[\w-]+$/.test(v)) {
    throw new Error("EBOOK_DISCORD_WEBHOOK must be a Discord webhook URL (https://discord.com/api/webhooks/…)");
  }
  return v;
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required (see .env.example)`);
  return value;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const mumateEnv = required(env, "MUMATE_ENV");
  if (mumateEnv !== "staging" && mumateEnv !== "production" && mumateEnv !== "development") {
    throw new Error(`MUMATE_ENV must be staging, production or development, not ${mumateEnv}`);
  }
  const hookSecret = required(env, "EBOOK_HOOK_SECRET");
  if (hookSecret.length < 32) throw new Error("EBOOK_HOOK_SECRET must be at least 32 characters");
  const open = env.EBOOK_OPEN === "1";
  if (open && mumateEnv !== "production") throw new Error("EBOOK_OPEN=1 is allowed on production only");
  return {
    env: mumateEnv,
    port: Number(env.PORT ?? 3000),
    databaseUrl: required(env, "EBOOK_DATABASE_URL"),
    manychatApiKey: required(env, "MANYCHAT_API_KEY"),
    manychatApiBase: env.MANYCHAT_API_BASE?.trim() || "https://api.manychat.com",
    hookSecret,
    allowlist: new Set(
      (env.EBOOK_ALLOWLIST ?? "").split(",").map((id) => id.trim()).filter((id) => /^\d+$/.test(id)),
    ),
    open,
    gitSha: env.GIT_SHA?.trim() || "unknown",
    slip: loadSlip(env),
    discordWebhook: loadWebhook(env.EBOOK_DISCORD_WEBHOOK),
  };
}

export function mayMessage(config: Pick<Config, "allowlist" | "open">, subscriberId: string): boolean {
  return config.open || config.allowlist.has(subscriberId);
}
