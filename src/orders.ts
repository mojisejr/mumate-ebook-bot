// What happens to a slip (CIEL mumate-manychat-ebook-001 slice 2, plan revision 0.4):
//
//   slip image → order (one per contact+image) → Slip2Go → pass:   claim transRef → paid → tag bot_paid + delivery flow
//                                                        → reject: bot_reason + tag bot_rejected + notice flow (admin told)
//                                                        → retry:  back off and try again, then hand to the admin
//                                                        → admin:  bot_reason + tag bot_admin + notice flow
//
// The delivery flow in ManyChat holds the same message the team sends by hand (E-Book link, the app coupon, the how-to
// image), so the team edits that text in ManyChat without touching this app. Delivery is claimed with one conditional
// UPDATE, so a repeated request, a retry tick and an admin's resend can never send it twice.
//
// A delivery ManyChat refuses is tried again by the minute tick (1, 5 and 30 min after each failure); after the last
// try the team's Discord room gets a red card with a link to the chat. Every delivered sale gets a green card.

import { createHash } from "node:crypto";
import type { SlipConfig } from "./config.ts";
import type { ManyChat } from "./manychat.ts";
import { silentNotifier, soldCard, stuckCard, type Notifier } from "./notify.ts";
import type { Order, OrderStore } from "./orders-store.ts";
import type { RejectReason, Slip2Go, Verdict } from "./slip2go.ts";

export const MAX_ATTEMPTS = 5;
export const TAG_PAID = "bot_paid";
export const TAG_REJECTED = "bot_rejected";
export const TAG_ADMIN = "bot_admin";
export const FIELD_REASON = "bot_reason";

const ADMIN_TAIL = "แอดมินได้รับแจ้งแล้ว จะช่วยดูให้ในแชทนี้ครับ 🙏";

export function reasonText(reason: RejectReason | "admin", price: number): string {
  switch (reason) {
    case "receiver":
      return `สลิปนี้โอนเข้าบัญชีอื่น ไม่ใช่บัญชีบริษัท มูเทค เดสตินี่ (กสิกรไทย) ครับ ${ADMIN_TAIL}`;
    case "amount":
      return `ยอดในสลิปไม่ตรงกับราคา ${price} บาทครับ ${ADMIN_TAIL}`;
    case "not_found":
      return `ระบบยังหาสลิปนี้ในธนาคารไม่เจอครับ บางธนาคารส่งข้อมูลช้า ${ADMIN_TAIL}`;
    case "fraud":
      return `สลิปนี้ตรวจกับธนาคารไม่ผ่านครับ ${ADMIN_TAIL}`;
    case "duplicate":
      return `สลิปนี้เคยใช้สั่งซื้อไปแล้วครับ ${ADMIN_TAIL}`;
    case "not_a_slip":
      return `รูปนี้อ่านเป็นสลิปไม่ได้ครับ ลองส่งรูปสลิปที่เห็น QR ชัด ๆ อีกครั้งได้เลย หรือรอแอดมินช่วยดู 🙏`;
    case "admin":
      return `ได้รับสลิปแล้วครับ แอดมินจะตรวจและส่ง E-Book ให้ในแชทนี้ 🙏`;
  }
}

export function imageHash(subscriberId: string, imageUrl: string): string {
  return createHash("sha256").update(`${subscriberId}\n${imageUrl}`).digest("hex");
}

export const REPEAT_QUIET_MS = 60_000;

// What a customer hears when they send a slip this contact already sent: the order keeps its status.
export function repeatText(order: Pick<Order, "status" | "reason">, price: number): string {
  if (order.status === "rejected" && order.reason && isRejectReason(order.reason)) return reasonText(order.reason, price);
  if (order.status === "admin") return reasonText("admin", price);
  return reasonText("duplicate", price);
}

const REJECT_REASONS = ["receiver", "amount", "not_found", "fraud", "duplicate", "not_a_slip"] as const;
function isRejectReason(r: string): r is RejectReason {
  return (REJECT_REASONS as readonly string[]).includes(r);
}

/** waits before the automatic delivery tries 2, 3 and 4; after the 4th failure the order goes to the team */
export const DELIVERY_RETRY_MS = [60_000, 5 * 60_000, 30 * 60_000] as const;

export function retryDelayMs(attempt: number): number {
  // 1, 2, 4, 8 minutes after attempts 1-4; the fifth failure goes to the admin
  return 60_000 * 2 ** Math.max(0, attempt - 1);
}

export interface ProcessorDeps {
  env: string;
  slip: SlipConfig;
  slip2go: Slip2Go;
  manychat: ManyChat;
  orders: OrderStore;
  notifier?: Notifier;
  now?: () => Date;
  log?: (entry: Record<string, unknown>) => void;
}

export type AdminResult = { ok: true; detail: string } | { ok: false; detail: string };

export function createProcessor(d: ProcessorDeps) {
  const now = d.now ?? (() => new Date());
  const log = d.log ?? ((entry) => console.log(JSON.stringify(entry)));
  const SYSTEM = "bot";
  const notifier = d.notifier ?? silentNotifier;

  async function card(order: Order, kind: "sold" | "stuck", extra: { tries?: number; error?: string } = {}): Promise<void> {
    const who = await d.manychat.contactInfo(order.subscriberId);
    const base = { id: order.id, amount: order.amount, name: who.name, chatUrl: who.chatUrl };
    await notifier.post(kind === "sold"
      ? soldCard({ ...base, at: now() })
      : stuckCard({ ...base, tries: extra.tries ?? 0, error: extra.error ?? "" }));
  }

  async function notice(order: Order, kind: "rejected" | "admin", text: string): Promise<void> {
    const tag = kind === "rejected" ? TAG_REJECTED : TAG_ADMIN;
    const steps = [
      await d.manychat.setField(order.subscriberId, FIELD_REASON, text),
      await d.manychat.addTag(order.subscriberId, tag),
      await d.manychat.sendFlow(order.subscriberId, d.slip.flowNotice),
    ];
    const failed = steps.filter((s) => !s.ok).map((s) => (s.ok ? "" : s.detail));
    await d.orders.log({ orderId: order.id, action: failed.length ? "notice_failed" : "notice_sent", by: SYSTEM,
      detail: { kind, ...(failed.length ? { errors: failed } : {}) } });
    if (failed.length) log({ msg: "notice_failed", order: order.id, env: d.env, errors: failed });
  }

  // auto = the bot's own try (first send or a retry tick): failures are scheduled again, then sent to the team.
  // sale = post the green card on success (false when an admin resends to a customer who already had it).
  async function deliver(orderId: number, by: string, opts: { auto: boolean; sale: boolean }): Promise<AdminResult> {
    if (!(await d.orders.claimDelivery(orderId))) return { ok: false, detail: "not paid, or already delivered" };
    const order = (await d.orders.get(orderId))!;
    const tag = await d.manychat.addTag(order.subscriberId, TAG_PAID);
    if (!tag.ok) log({ msg: "tag_failed", order: orderId, env: d.env, error: tag.detail });
    const sent = await d.manychat.sendFlow(order.subscriberId, d.slip.flowDeliver);
    if (!sent.ok) {
      await d.orders.deliveryFailed(orderId, sent.detail);
      await d.orders.log({ orderId, action: "delivery_failed", by, detail: { error: sent.detail } });
      log({ msg: "delivery_failed", order: orderId, env: d.env, error: sent.detail });
      if (opts.auto) {
        const tries = await d.orders.countLog(orderId, "delivery_failed");
        const wait = DELIVERY_RETRY_MS[tries - 1];
        if (wait !== undefined) {
          await d.orders.scheduleDelivery(orderId, new Date(now().getTime() + wait));
        } else {
          await d.orders.scheduleDelivery(orderId, null);
          await d.orders.log({ orderId, action: "delivery_gave_up", by, detail: { tries } });
          log({ msg: "alert", what: "paid but not delivered", order: orderId, env: d.env, tries });
          await card(order, "stuck", { tries, error: sent.detail });
        }
      }
      return { ok: false, detail: sent.detail };
    }
    await d.orders.log({ orderId, action: "delivered", by });
    log({ msg: "delivered", order: orderId, env: d.env });
    if (opts.sale) await card(order, "sold");
    return { ok: true, detail: "delivered" };
  }

  async function apply(order: Order, v: Verdict): Promise<void> {
    await d.orders.log({ orderId: order.id, action: "checked", by: SYSTEM, detail: { kind: v.kind, code: v.code } });
    if (v.kind === "pass") {
      if (!v.slip.transRef) {
        await d.orders.setResult(order.id, { status: "admin", slipCode: v.code, reason: "pass without transRef" });
        return notice(order, "admin", reasonText("admin", d.slip.price));
      }
      if (!(await d.orders.claimTransRef(order.id, v.slip.transRef))) {
        await d.orders.setResult(order.id, { status: "rejected", slipCode: v.code, reason: "duplicate (our table)" });
        return notice(order, "rejected", reasonText("duplicate", d.slip.price));
      }
      await d.orders.setResult(order.id, {
        status: "paid", slipCode: v.code, amount: v.slip.amount, slipAt: v.slip.dateTime, senderName: v.slip.senderName,
      });
      await deliver(order.id, SYSTEM, { auto: true, sale: true });
      return;
    }
    if (v.kind === "reject") {
      await d.orders.setResult(order.id, { status: "rejected", slipCode: v.code, reason: v.reason, amount: v.slip?.amount ?? null });
      return notice(order, "rejected", reasonText(v.reason, d.slip.price));
    }
    if (v.kind === "retry") {
      const attempts = order.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        await d.orders.setResult(order.id, { status: "admin", slipCode: v.code, reason: `gave up after ${attempts}: ${v.detail}`, attempts });
        log({ msg: "alert", what: "slip check kept failing", order: order.id, env: d.env, code: v.code });
        return notice(order, "admin", reasonText("admin", d.slip.price));
      }
      await d.orders.setResult(order.id, {
        status: "retry", slipCode: v.code, reason: v.detail, attempts,
        nextAttemptAt: new Date(now().getTime() + retryDelayMs(attempts)),
      });
      return;
    }
    await d.orders.setResult(order.id, { status: "admin", slipCode: v.code, reason: v.detail });
    // 401xxx: token, credit, package, key or IP. Every following slip fails the same way until the team acts.
    if (v.alert) log({ msg: "alert", what: "Slip2Go refused our account", order: order.id, env: d.env, code: v.code });
    return notice(order, "admin", reasonText("admin", d.slip.price));
  }

  async function check(order: Order): Promise<void> {
    const verdict = await d.slip2go.verifyImageLink(order.imageUrl);
    await apply(order, verdict);
  }

  return {
    async handleSlip(subscriberId: string, imageUrl: string): Promise<{ order: Order; created: boolean }> {
      const opened = await d.orders.open({ env: d.env, subscriberId, imageHash: imageHash(subscriberId, imageUrl), imageUrl });
      if (!opened.created) {
        const o = opened.order;
        // A ManyChat retry or a double tap arrives within seconds, often while the first check is still running: stay
        // quiet. Later, the customer sent the same slip again on purpose: answer with a reason and tell the admin.
        const quiet = o.status === "checking" || o.status === "retry" || now().getTime() - o.createdAt.getTime() < REPEAT_QUIET_MS;
        await d.orders.log({ orderId: o.id, action: quiet ? "repeat_request" : "repeat_slip", by: SYSTEM });
        if (!quiet) await notice(o, "rejected", repeatText(o, d.slip.price));
        return opened;
      }
      await d.orders.log({ orderId: opened.order.id, action: "received", by: SYSTEM });
      await check(opened.order);
      return opened;
    },

    async retryDue(): Promise<number> {
      const due = await d.orders.dueRetries(d.env, now());
      for (const order of due) await check(order);
      return due.length;
    },

    // Paid orders whose delivery ManyChat refused: try again when due (same minute tick as the slip retries).
    async retryDeliveries(): Promise<number> {
      const due = await d.orders.dueDeliveries(d.env, now());
      for (const order of due) await deliver(order.id, SYSTEM, { auto: true, sale: true });
      return due.length;
    },

    // An admin sent the E-Book by hand: close the order so it stops showing as not delivered and the bot stops trying.
    async markDelivered(orderId: number, by: string, reason: string, dryRun: boolean): Promise<AdminResult> {
      const order = await d.orders.get(orderId);
      if (!order) return { ok: false, detail: `no order ${orderId}` };
      if (order.status !== "paid") return { ok: false, detail: `order is ${order.status}, not paid` };
      if (order.deliveredAt) return { ok: false, detail: "already delivered" };
      if (dryRun) return { ok: true, detail: `would mark order ${orderId} delivered by hand` };
      if (!(await d.orders.markDelivered(orderId))) return { ok: false, detail: "not paid, or already delivered" };
      await d.orders.log({ orderId, action: "mark_delivered", by, reason });
      return { ok: true, detail: "marked delivered" };
    },

    // An admin confirmed the money by hand (for example a slip Slip2Go could not find). Records who and why, then delivers.
    async markPaid(orderId: number, by: string, reason: string, dryRun: boolean): Promise<AdminResult> {
      const order = await d.orders.get(orderId);
      if (!order) return { ok: false, detail: `no order ${orderId}` };
      if (order.status === "paid") return { ok: false, detail: "already paid; use resend if the customer has nothing" };
      if (dryRun) return { ok: true, detail: `would mark order ${orderId} (${order.status}) paid and deliver` };
      await d.orders.setResult(orderId, { status: "paid", slipCode: order.slipCode, reason: `marked paid: ${reason}` });
      await d.orders.log({ orderId, action: "mark_paid", by, reason });
      return deliver(orderId, by, { auto: false, sale: true });
    },

    // Send the delivery flow again for a paid order (the first send failed, or the customer lost the message).
    async resend(orderId: number, by: string, reason: string, dryRun: boolean): Promise<AdminResult> {
      const order = await d.orders.get(orderId);
      if (!order) return { ok: false, detail: `no order ${orderId}` };
      if (order.status !== "paid") return { ok: false, detail: `order is ${order.status}, not paid` };
      if (dryRun) return { ok: true, detail: `would send the delivery flow again for order ${orderId}` };
      await d.orders.log({ orderId, action: "resend", by, reason });
      const hadIt = !!order.deliveredAt;
      if (hadIt) await d.orders.deliveryFailed(orderId, `resend requested: ${reason}`);
      return deliver(orderId, by, { auto: false, sale: !hadIt });
    },
  };
}

export type Processor = ReturnType<typeof createProcessor>;
