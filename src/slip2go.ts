// Slip2Go Verify Slip API, image-link endpoint (dashboard of shop "mumate", read 2026-11-09; CIEL plan revision 0.3).
//
//   POST {apiUrl}/api/verify-slip/qr-image-link/info   Authorization: Bearer <secret key>
//   { payload: { imageUrl, checkCondition: { checkDuplicate, checkReceiver: [...], checkAmount: { type, amount } } } }
//
// Slip2Go answers a JSON body with a six-digit `code` on HTTP 200 and on errors alike, so the code decides, not the status.

import type { Fetch } from "./manychat.ts";

export type Verdict =
  | { kind: "pass"; code: string; slip: SlipFacts }
  | { kind: "reject"; code: string; reason: RejectReason; slip?: SlipFacts }
  | { kind: "retry"; code: string; detail: string }
  | { kind: "admin"; code: string; detail: string; alert: boolean };

export type RejectReason = "receiver" | "amount" | "not_found" | "fraud" | "duplicate" | "not_a_slip";

export interface SlipFacts {
  transRef: string | null;
  amount: number | null;
  dateTime: string | null;
  senderName: string | null;
}

// Plan revision 0.3: only 200200 ("Slip is valid": every condition we sent held) is a pass. 200000 means the slip
// was found without our conditions being checked, so it must never pay.
const REJECT: Record<string, RejectReason> = {
  "200401": "receiver",
  "200402": "amount",
  "200404": "not_found",
  "200500": "fraud",
  "200501": "duplicate",
};
const RETRY = new Set(["200502", "429000", "500500", "500503"]);

export function classify(code: string, data: unknown): Verdict {
  const slip = facts(data);
  if (code === "200200") return { kind: "pass", code, slip };
  const reason = REJECT[code];
  if (reason) return { kind: "reject", code, reason, slip };
  if (/^400\d{3}$/.test(code)) return { kind: "reject", code, reason: "not_a_slip" };
  if (RETRY.has(code)) return { kind: "retry", code, detail: `Slip2Go ${code}` };
  // 401xxx is our side (token, credit, package, key, IP): a customer cannot fix it, the team must, now.
  if (/^401\d{3}$/.test(code)) return { kind: "admin", code, detail: `Slip2Go ${code}`, alert: true };
  return { kind: "admin", code, detail: `Slip2Go unknown code ${code}`, alert: false };
}

function facts(data: unknown): SlipFacts {
  const d = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  const amount = typeof d.amount === "number" ? d.amount : typeof d.amount === "string" ? Number(d.amount) : NaN;
  return {
    transRef: typeof d.transRef === "string" && d.transRef ? d.transRef : null,
    amount: Number.isFinite(amount) ? amount : null,
    dateTime: typeof d.dateTime === "string" ? d.dateTime : null,
    senderName: senderName(d.sender),
  };
}

// The sender object's exact shape is not documented on the pages read; take the first name-like string found.
function senderName(sender: unknown): string | null {
  if (typeof sender !== "object" || sender === null) return null;
  const s = sender as Record<string, unknown>;
  const account = (typeof s.account === "object" && s.account !== null ? s.account : {}) as Record<string, unknown>;
  const name = account.name ?? s.name ?? s.displayName;
  if (typeof name === "string") return name.slice(0, 200);
  if (typeof name === "object" && name !== null) {
    const n = name as Record<string, unknown>;
    const v = n.th ?? n.en;
    if (typeof v === "string") return v.slice(0, 200);
  }
  return null;
}

export interface Slip2GoConfig {
  apiUrl: string;
  secretKey: string;
  receiverAccountType: string;
  receiverAccountNumber: string;
  price: number;
}

export interface Slip2Go {
  verifyImageLink(imageUrl: string): Promise<Verdict>;
}

export function createSlip2Go(cfg: Slip2GoConfig, opts: { fetch?: Fetch; timeoutMs?: number } = {}): Slip2Go {
  const doFetch = opts.fetch ?? fetch;
  return {
    async verifyImageLink(imageUrl) {
      const body = {
        payload: {
          imageUrl,
          checkCondition: {
            checkDuplicate: true,
            // Bank and account number only: real slips print the short name "บจก. มูเทค เดสตินี่" (plan revision 0.4).
            checkReceiver: [{ accountType: cfg.receiverAccountType, accountNumber: cfg.receiverAccountNumber }],
            checkAmount: { type: "eq", amount: String(cfg.price) },
          },
        },
      };
      let res: Response;
      try {
        res = await doFetch(`${cfg.apiUrl}/api/verify-slip/qr-image-link/info`, {
          method: "POST",
          headers: { Authorization: `Bearer ${cfg.secretKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 20000),
        });
      } catch (error) {
        return { kind: "retry", code: "network", detail: error instanceof Error ? error.message : String(error) };
      }
      const text = await res.text().catch(() => "");
      let parsed: { code?: unknown; data?: unknown } = {};
      try {
        parsed = JSON.parse(text);
      } catch {
        // not JSON: a proxy page or an outage
        return res.status >= 500
          ? { kind: "retry", code: `http_${res.status}`, detail: text.slice(0, 200) }
          : { kind: "admin", code: `http_${res.status}`, detail: text.slice(0, 200), alert: true };
      }
      const code = typeof parsed.code === "string" ? parsed.code : String(parsed.code ?? "");
      if (!/^\d{6}$/.test(code)) {
        return res.status >= 500
          ? { kind: "retry", code: `http_${res.status}`, detail: "no code" }
          : { kind: "admin", code: `http_${res.status}`, detail: "no code in answer", alert: false };
      }
      return classify(code, parsed.data);
    },
  };
}
