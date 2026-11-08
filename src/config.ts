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
  };
}

export function mayMessage(config: Pick<Config, "allowlist" | "open">, subscriberId: string): boolean {
  return config.open || config.allowlist.has(subscriberId);
}
