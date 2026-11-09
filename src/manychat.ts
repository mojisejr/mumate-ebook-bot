// The small part of the ManyChat Page API this app uses (api.manychat.com/swagger, read 2026-11-08).
// Sending works only inside Messenger's 24-hour window; outside it ManyChat answers with an error, which we record.
// Tags and fields are addressed by name, and they must already exist in ManyChat (all start with bot_, plan 0.2).

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
export type Sent = { ok: true } | { ok: false; detail: string };

export interface ManyChat {
  sendText(subscriberId: string, text: string): Promise<Sent>;
  sendFlow(subscriberId: string, flowNs: string): Promise<Sent>;
  addTag(subscriberId: string, tagName: string): Promise<Sent>;
  setField(subscriberId: string, fieldName: string, value: string): Promise<Sent>;
}

export function createManyChat(opts: { apiKey: string; apiBase: string; fetch?: Fetch; timeoutMs?: number }): ManyChat {
  const doFetch = opts.fetch ?? fetch;
  async function post(path: string, body: Record<string, unknown>): Promise<Sent> {
    try {
      const res = await doFetch(`${opts.apiBase}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
      });
      const text = await res.text();
      // ManyChat answers 200 with {"status":"success"} on success; anything else is a failure worth recording.
      if (res.ok && /"status"\s*:\s*"success"/.test(text)) return { ok: true };
      return { ok: false, detail: `${path} HTTP ${res.status}: ${text.slice(0, 300)}` };
    } catch (error) {
      return { ok: false, detail: `${path} ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return {
    sendText: (id, text) =>
      post("/fb/sending/sendContent", {
        subscriber_id: Number(id),
        data: { version: "v2", content: { messages: [{ type: "text", text }] } },
      }),
    sendFlow: (id, flowNs) => post("/fb/sending/sendFlow", { subscriber_id: Number(id), flow_ns: flowNs }),
    addTag: (id, tagName) => post("/fb/subscriber/addTagByName", { subscriber_id: Number(id), tag_name: tagName }),
    setField: (id, fieldName, value) =>
      post("/fb/subscriber/setCustomFieldByName", { subscriber_id: Number(id), field_name: fieldName, field_value: value }),
  };
}
