// Orders (migrations/0002_ebook_order.sql). Every state change that matters is a single conditional UPDATE, so a
// repeated ManyChat request, a retry tick and an admin command can never deliver the same order twice.

import { SQL } from "bun";

export type OrderStatus = "checking" | "retry" | "paid" | "rejected" | "admin";

export interface Order {
  id: number;
  createdAt: Date;
  env: string;
  subscriberId: string;
  imageUrl: string;
  status: OrderStatus;
  slipCode: string | null;
  reason: string | null;
  transRef: string | null;
  amount: number | null;
  attempts: number;
  nextAttemptAt: Date | null;
  deliveredAt: Date | null;
  deliveryError: string | null;
}

export interface ResultPatch {
  status: OrderStatus;
  slipCode?: string | null;
  reason?: string | null;
  amount?: number | null;
  slipAt?: string | null;
  senderName?: string | null;
  attempts?: number;
  nextAttemptAt?: Date | null;
}

export interface OrderStore {
  // Returns the existing order when this contact already sent this exact image (a ManyChat retry or a double tap).
  open(o: { env: string; subscriberId: string; imageHash: string; imageUrl: string }): Promise<{ order: Order; created: boolean }>;
  get(id: number): Promise<Order | null>;
  setResult(id: number, patch: ResultPatch): Promise<void>;
  // false = another order already holds this transRef (the slip paid before)
  claimTransRef(id: number, transRef: string): Promise<boolean>;
  // true exactly once per order: the caller that wins sends the delivery flow
  claimDelivery(id: number): Promise<boolean>;
  deliveryFailed(id: number, error: string): Promise<void>;
  dueRetries(env: string, now: Date): Promise<Order[]>;
  list(env: string, opts: { sinceHours: number; status?: OrderStatus[]; undelivered?: boolean }): Promise<Order[]>;
  log(entry: { orderId: number; action: string; by: string; reason?: string; detail?: Record<string, unknown> }): Promise<void>;
}

type Row = Record<string, unknown>;
const toOrder = (r: Row): Order => ({
  id: Number(r.id),
  createdAt: new Date(r.created_at as string),
  env: r.env as string,
  subscriberId: r.subscriber_id as string,
  imageUrl: r.image_url as string,
  status: r.status as OrderStatus,
  slipCode: (r.slip_code as string) ?? null,
  reason: (r.reason as string) ?? null,
  transRef: (r.trans_ref as string) ?? null,
  amount: r.amount === null || r.amount === undefined ? null : Number(r.amount),
  attempts: Number(r.attempts ?? 0),
  nextAttemptAt: r.next_attempt_at ? new Date(r.next_attempt_at as string) : null,
  deliveredAt: r.delivered_at ? new Date(r.delivered_at as string) : null,
  deliveryError: (r.delivery_error as string) ?? null,
});

export function createPgOrderStore(sql: SQL): OrderStore {
  return {
    async open(o) {
      const inserted = await sql`
        INSERT INTO ebook_order (env, subscriber_id, image_hash, image_url)
        VALUES (${o.env}, ${o.subscriberId}, ${o.imageHash}, ${o.imageUrl})
        ON CONFLICT (env, image_hash) DO NOTHING
        RETURNING *`;
      if (inserted.length) return { order: toOrder(inserted[0]), created: true };
      const existing = await sql`SELECT * FROM ebook_order WHERE env = ${o.env} AND image_hash = ${o.imageHash}`;
      return { order: toOrder(existing[0]), created: false };
    },
    async get(id) {
      const rows = await sql`SELECT * FROM ebook_order WHERE id = ${id}`;
      return rows.length ? toOrder(rows[0]) : null;
    },
    async setResult(id, p) {
      await sql`
        UPDATE ebook_order SET
          updated_at = now(),
          status = ${p.status},
          slip_code = COALESCE(${p.slipCode ?? null}, slip_code),
          reason = ${p.reason ?? null},
          amount = COALESCE(${p.amount ?? null}, amount),
          slip_at = COALESCE(${p.slipAt ?? null}::timestamptz, slip_at),
          sender_name = COALESCE(${p.senderName ?? null}, sender_name),
          attempts = COALESCE(${p.attempts ?? null}, attempts),
          next_attempt_at = ${p.nextAttemptAt ?? null}
        WHERE id = ${id}`;
    },
    async claimTransRef(id, transRef) {
      try {
        const rows = await sql`
          UPDATE ebook_order SET trans_ref = ${transRef}, updated_at = now()
          WHERE id = ${id} AND (trans_ref IS NULL OR trans_ref = ${transRef}) RETURNING id`;
        return rows.length === 1;
      } catch (error) {
        // 23505 unique_violation on ebook_order_trans_ref_uq: an earlier order owns this slip
        if ((error as { errno?: string; code?: string }).errno === "23505" || /23505|unique/i.test(String(error))) return false;
        throw error;
      }
    },
    async claimDelivery(id) {
      const rows = await sql`
        UPDATE ebook_order SET delivered_at = now(), delivery_error = NULL, updated_at = now()
        WHERE id = ${id} AND status = 'paid' AND delivered_at IS NULL RETURNING id`;
      return rows.length === 1;
    },
    async deliveryFailed(id, error) {
      await sql`UPDATE ebook_order SET delivered_at = NULL, delivery_error = ${error.slice(0, 500)}, updated_at = now() WHERE id = ${id}`;
    },
    async dueRetries(env, now) {
      const rows = await sql`
        SELECT * FROM ebook_order WHERE env = ${env} AND status = 'retry' AND next_attempt_at <= ${now}
        ORDER BY next_attempt_at LIMIT 20`;
      return rows.map(toOrder);
    },
    async list(env, opts) {
      const since = new Date(Date.now() - opts.sinceHours * 3600_000);
      const rows = await sql`SELECT * FROM ebook_order WHERE env = ${env} AND created_at >= ${since} ORDER BY created_at DESC LIMIT 500`;
      return (rows as Row[]).map(toOrder).filter((o: Order) =>
        (!opts.status || opts.status.includes(o.status)) && (!opts.undelivered || (o.status === "paid" && !o.deliveredAt)));
    },
    async log(e) {
      await sql`
        INSERT INTO ebook_order_log (order_id, action, by_whom, reason, detail)
        VALUES (${e.orderId}, ${e.action}, ${e.by}, ${e.reason ?? null}, ${e.detail ?? {}})`;
    },
  };
}

export function createMemoryOrderStore(): OrderStore & { orders: Order[]; logs: { orderId: number; action: string; by: string; reason?: string }[] } {
  const orders: Order[] = [];
  const hashes = new Map<string, number>();
  const logs: { orderId: number; action: string; by: string; reason?: string }[] = [];
  const find = (id: number) => orders.find((o) => o.id === id) ?? null;
  return {
    orders,
    logs,
    async open(o) {
      const key = `${o.env}:${o.imageHash}`;
      const known = hashes.get(key);
      if (known !== undefined) return { order: { ...find(known)! }, created: false };
      const order: Order = {
        id: orders.length + 1, createdAt: new Date(), env: o.env, subscriberId: o.subscriberId, imageUrl: o.imageUrl,
        status: "checking", slipCode: null, reason: null, transRef: null, amount: null, attempts: 0,
        nextAttemptAt: null, deliveredAt: null, deliveryError: null,
      };
      orders.push(order);
      hashes.set(key, order.id);
      return { order: { ...order }, created: true };
    },
    async get(id) {
      const o = find(id);
      return o ? { ...o } : null;
    },
    async setResult(id, p) {
      const o = find(id)!;
      o.status = p.status;
      if (p.slipCode != null) o.slipCode = p.slipCode;
      o.reason = p.reason ?? null;
      if (p.amount != null) o.amount = p.amount;
      if (p.attempts != null) o.attempts = p.attempts;
      o.nextAttemptAt = p.nextAttemptAt ?? null;
    },
    async claimTransRef(id, transRef) {
      const o = find(id)!;
      if (orders.some((x) => x.id !== id && x.env === o.env && x.transRef === transRef)) return false;
      if (o.transRef && o.transRef !== transRef) return false;
      o.transRef = transRef;
      return true;
    },
    async claimDelivery(id) {
      const o = find(id)!;
      if (o.status !== "paid" || o.deliveredAt) return false;
      o.deliveredAt = new Date();
      o.deliveryError = null;
      return true;
    },
    async deliveryFailed(id, error) {
      const o = find(id)!;
      o.deliveredAt = null;
      o.deliveryError = error;
    },
    async dueRetries(env, now) {
      return orders.filter((o) => o.env === env && o.status === "retry" && o.nextAttemptAt && o.nextAttemptAt <= now).map((o) => ({ ...o }));
    },
    async list(env, opts) {
      return orders.filter((o) => o.env === env &&
        (!opts.status || opts.status.includes(o.status)) && (!opts.undelivered || (o.status === "paid" && !o.deliveredAt)))
        .map((o) => ({ ...o })).reverse();
    },
    async log(e) {
      logs.push({ orderId: e.orderId, action: e.action, by: e.by, reason: e.reason });
    },
  };
}
