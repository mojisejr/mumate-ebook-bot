// Funnel events (CIEL mumate-manychat-ebook-001 slice 4): which step of the live "Bazi E-Book 95" flow a contact
// reached, and the reason they chose in FU1 when they did not pay. bdash reads ebook_funnel_event for the summary
// page ("คนหลุดตรงไหนมากที่สุด?", "ทำไมคนกดซื้อแล้วไม่โอน?"). Slips, checks and deliveries are not here: they are
// already in ebook_order.
//
// Only the names below are accepted, so a typo in a ManyChat body is a 400 the builder's Test Request shows, never a
// new row nobody counts. No message text is stored, only a step name and one value from a fixed list.

import type { SQL } from "bun";

export const FUNNEL_STEPS = {
  entry: [], //                                1 ข้อความแรก (ManyChat cannot tell the comment trigger from the keyword one here)
  sample: [], //                               2a ตัวอย่าง+รีวิว
  faq: ["menu", "beginner", "file", "app", "delivery", "admin"], // FAQ เมนูคำถาม and FAQ1-FAQ5
  buy: [], //                                  2b สั่งซื้อ + วิธีโอน (the account number was shown)
  reason_asked: [], //                         FU1 was sent (30 min after buy, no slip yet)
  reason: ["not_now", "want_qr", "think", "price", "question", "howto"], // the FU1 button they pressed
} as const satisfies Record<string, readonly string[]>;

export type FunnelStep = keyof typeof FUNNEL_STEPS;

export interface FunnelEvent {
  env: string;
  subscriberId: string;
  step: FunnelStep;
  value: string | null;
}

export interface FunnelStore {
  record(e: FunnelEvent): Promise<void>;
}

// { subscriber_id, step, value? }: a step with a value list needs one of its values; a step without one takes none.
export function parseFunnel(body: unknown): { subscriberId: string; step: FunnelStep; value: string | null } | null {
  if (typeof body !== "object" || body === null) return null;
  const { subscriber_id, step, value } = body as Record<string, unknown>;
  const id = typeof subscriber_id === "number" ? String(subscriber_id) : subscriber_id;
  if (typeof id !== "string" || !/^\d{1,20}$/.test(id)) return null;
  if (typeof step !== "string" || !Object.hasOwn(FUNNEL_STEPS, step)) return null;
  const allowed: readonly string[] = FUNNEL_STEPS[step as FunnelStep];
  const v = value === undefined || value === null || value === "" ? null : value;
  if (allowed.length === 0) return v === null ? { subscriberId: id, step: step as FunnelStep, value: null } : null;
  if (typeof v !== "string" || !allowed.includes(v)) return null;
  return { subscriberId: id, step: step as FunnelStep, value: v };
}

export function createPgFunnelStore(sql: SQL): FunnelStore {
  return {
    async record(e) {
      await sql`INSERT INTO ebook_funnel_event (env, subscriber_id, step, value) VALUES (${e.env}, ${e.subscriberId}, ${e.step}, ${e.value})`;
    },
  };
}

export function createMemoryFunnelStore(): FunnelStore & { events: FunnelEvent[]; failing: boolean } {
  const s = {
    events: [] as FunnelEvent[],
    failing: false,
    async record(e: FunnelEvent) {
      if (s.failing) throw new Error("database down");
      s.events.push(e);
    },
  };
  return s;
}
