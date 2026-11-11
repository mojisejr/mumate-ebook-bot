// Discord cards for the team's E-Book room (owner 2026-11-11): one card per sale, and one when a paid order could not
// be delivered after the retries. Each card links straight to the customer's chat in ManyChat, so an admin acts at once.
// The webhook is optional (EBOOK_DISCORD_WEBHOOK); without it nothing is posted. A failed post is logged, never thrown,
// so a Discord outage can never stop a delivery.

import type { Fetch } from "./manychat.ts";

export const COLOR_SOLD = 0x2e9e5b; // green
export const COLOR_STUCK = 0xc0392b; // red

export type Card = { title: string; color: number; url?: string; fields: { name: string; value: string; inline?: boolean }[]; footer?: string };

export interface Notifier {
  post(card: Card): Promise<void>;
}

export function createNotifier(opts: { webhook: string | null; fetch?: Fetch; log?: (e: Record<string, unknown>) => void }): Notifier {
  const doFetch = opts.fetch ?? fetch;
  const log = opts.log ?? ((e) => console.log(JSON.stringify(e)));
  return {
    async post(card) {
      if (!opts.webhook) return;
      const embed = {
        title: card.title.slice(0, 256),
        color: card.color,
        ...(card.url ? { url: card.url } : {}),
        fields: card.fields.slice(0, 10).map((f) => ({ name: f.name.slice(0, 256), value: f.value.slice(0, 1024) || "-", inline: f.inline ?? true })),
        ...(card.footer ? { footer: { text: card.footer.slice(0, 2048) } } : {}),
        timestamp: new Date().toISOString(),
      };
      try {
        const res = await doFetch(opts.webhook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: "MuMate E-Book", embeds: [embed], allowed_mentions: { parse: [] } }),
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) log({ msg: "discord_failed", status: res.status });
      } catch (error) {
        log({ msg: "discord_failed", error: error instanceof Error ? error.name : "unknown" });
      }
    },
  };
}

export const silentNotifier: Notifier = { async post() {} };

const bkk = (d: Date) => d.toLocaleString("th-TH", { timeZone: "Asia/Bangkok", dateStyle: "short", timeStyle: "short" });

export function soldCard(o: { id: number; amount: number | null; name: string | null; chatUrl: string | null; at: Date }): Card {
  return {
    title: `✅ ขายได้ · ${o.name ?? "ลูกค้า"}`,
    color: COLOR_SOLD,
    url: o.chatUrl ?? undefined,
    fields: [
      { name: "ยอด", value: o.amount === null ? "-" : `${o.amount} บาท` },
      { name: "ออเดอร์", value: `#${o.id}` },
      { name: "เวลา", value: bkk(o.at) },
      { name: "สถานะ", value: "บอทส่ง E-Book + โค้ดแล้ว ไม่ต้องส่งซ้ำ", inline: false },
      ...(o.chatUrl ? [{ name: "เปิดแชท", value: `[เปิดแชทลูกค้าใน ManyChat](${o.chatUrl})`, inline: false }] : []),
    ],
  };
}

export function stuckCard(o: { id: number; amount: number | null; name: string | null; chatUrl: string | null; retrying: boolean; error: string }): Card {
  return {
    title: `⚠️ จ่ายแล้วแต่ยังไม่ได้ของ · ${o.name ?? "ลูกค้า"}`,
    color: COLOR_STUCK,
    url: o.chatUrl ?? undefined,
    fields: [
      { name: "ยอด", value: o.amount === null ? "-" : `${o.amount} บาท` },
      { name: "ออเดอร์", value: `#${o.id}` },
      { name: "ต้องทำ", value: "ส่งลิงก์ E-Book + โค้ดให้ลูกค้าในแชทเลย แล้วแจ้งให้ปิดออเดอร์นี้", inline: false },
      ...(o.retrying ? [{ name: "หมายเหตุ", value: "บอทยังลองส่งเองต่ออีก 2 ครั้งใน 8 นาที ถ้าส่งได้จะมีการ์ดเขียว ลูกค้าอาจได้ลิงก์ 2 ครั้ง ไม่เป็นไร", inline: false }] : []),
      ...(o.chatUrl ? [{ name: "เปิดแชท", value: `[เปิดแชทลูกค้าใน ManyChat](${o.chatUrl})`, inline: false }] : []),
      { name: "สาเหตุจาก ManyChat", value: o.error.replace(/^\/\S+\s*/, "").slice(0, 200), inline: false },
    ],
    footer: `ปิดออเดอร์: bin/ebook.sh mark-delivered ${o.id} --by <ชื่อ> --reason "ส่งให้ในแชทแล้ว"`,
  };
}
