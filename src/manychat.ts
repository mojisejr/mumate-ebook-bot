// The small part of the ManyChat Page API this app uses (api.manychat.com/swagger, read 2026-11-08).
// Sending works only inside Messenger's 24-hour window; outside it ManyChat answers with an error, which we record.
// Tags and fields are addressed by name, and they must already exist in ManyChat (all start with bot_, plan 0.2).

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
export type Sent = { ok: true } | { ok: false; detail: string };
/** who the contact is, for the team's Discord card: display name and the Live Chat link (null when ManyChat does not answer) */
export type ContactInfo = { name: string | null; chatUrl: string | null };

export interface ManyChat {
  sendText(subscriberId: string, text: string): Promise<Sent>;
  sendFlow(subscriberId: string, flowNs: string): Promise<Sent>;
  addTag(subscriberId: string, tagName: string): Promise<Sent>;
  setField(subscriberId: string, fieldName: string, value: string): Promise<Sent>;
  contactInfo(subscriberId: string): Promise<ContactInfo>;
}

export function createManyChat(opts: { apiKey: string; apiBase: string; fetch?: Fetch; timeoutMs?: number }): ManyChat {
  const doFetch = opts.fetch ?? fetch;
  // ManyChat ids are 17 digits, above Number.MAX_SAFE_INTEGER: Number(id) rounds some of them to an id that does not
  // exist ("Subscriber does not exist", 5 of 9 production orders on 2026-11-11). The digits go into the JSON as written.
  async function post(path: string, id: string, rest: Record<string, unknown>): Promise<Sent> {
    if (!/^\d{1,20}$/.test(id)) return { ok: false, detail: `${path} subscriber id not digits` };
    try {
      const res = await doFetch(`${opts.apiBase}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
        body: `{"subscriber_id":${id},${JSON.stringify(rest).slice(1)}`,
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
  async function contactInfo(id: string): Promise<ContactInfo> {
    try {
      const res = await doFetch(`${opts.apiBase}/fb/subscriber/getInfo?subscriber_id=${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${opts.apiKey}` },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
      });
      const j = (await res.json().catch(() => null)) as { data?: { name?: unknown; live_chat_url?: unknown } } | null;
      const name = typeof j?.data?.name === "string" && j.data.name.trim() ? j.data.name.trim().slice(0, 80) : null;
      const url = typeof j?.data?.live_chat_url === "string" && /^https:\/\/app\.manychat\.com\/[\w/?=&.-]+$/.test(j.data.live_chat_url) ? j.data.live_chat_url : null;
      return { name, chatUrl: url };
    } catch {
      return { name: null, chatUrl: null };
    }
  }
  return {
    contactInfo,
    sendText: (id, text) =>
      post("/fb/sending/sendContent", id, {
        data: { version: "v2", content: { messages: [{ type: "text", text }] } },
      }),
    sendFlow: (id, flowNs) => post("/fb/sending/sendFlow", id, { flow_ns: flowNs }),
    addTag: (id, tagName) => post("/fb/subscriber/addTagByName", id, { tag_name: tagName }),
    setField: (id, fieldName, value) =>
      post("/fb/subscriber/setCustomFieldByName", id, { field_name: fieldName, field_value: value }),
  };
}
