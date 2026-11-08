// The small part of the ManyChat Page API this app uses (api.manychat.com/swagger, read 2026-11-08).
// sendContent works only inside Messenger's 24-hour window; outside it ManyChat answers with an error, which we record.

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface ManyChat {
  sendText(subscriberId: string, text: string): Promise<{ ok: true } | { ok: false; detail: string }>;
}

export function createManyChat(opts: { apiKey: string; apiBase: string; fetch?: Fetch; timeoutMs?: number }): ManyChat {
  const doFetch = opts.fetch ?? fetch;
  return {
    async sendText(subscriberId, text) {
      const body = {
        subscriber_id: Number(subscriberId),
        data: { version: "v2", content: { messages: [{ type: "text", text }] } },
      };
      try {
        const res = await doFetch(`${opts.apiBase}/fb/sending/sendContent`, {
          method: "POST",
          headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
        });
        const text = await res.text();
        // ManyChat answers 200 with {"status":"success"} on success; anything else is a failure worth recording.
        if (res.ok && /"status"\s*:\s*"success"/.test(text)) return { ok: true };
        return { ok: false, detail: `HTTP ${res.status}: ${text.slice(0, 300)}` };
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
