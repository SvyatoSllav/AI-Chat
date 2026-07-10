import { Platform, requestUrl } from "obsidian";
import { ChatRequest, LLMProvider } from "./types";

export interface AccountInfo {
  email: string;
  used: number;
  freeQuota: number;
  pro: boolean;
  proUntil: string | null;
  checkoutUrl: string;
}

/**
 * Hosted subscription provider: our control plane proxies to GLM.
 * Auth is a JWT obtained via email code in settings. 5 messages free,
 * then the backend answers 402 with a checkout link.
 */
export class HostedProvider implements LLMProvider {
  id = "hosted";
  supportsMobile = true;

  constructor(
    private backendUrl: string,
    private token: string,
  ) {}

  async chat(req: ChatRequest, onDelta: (chunk: string) => void): Promise<string> {
    if (!this.token) {
      throw new Error("Sign in first: ZettelkastenAI settings → Account → Send code.");
    }
    const url = this.backendUrl.replace(/\/+$/, "") + "/api/chat";

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ messages: req.messages, stream: true }),
        signal: req.signal,
      });
    } catch (e) {
      if (req.signal?.aborted) throw e;
      if (Platform.isMobileApp) return this.chatViaRequestUrl(url, req, onDelta);
      throw e;
    }
    if (!res.ok || !res.body) {
      throw new Error(await describeError(res.status, () => res.text()));
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let full = "";
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const delta = JSON.parse(data).choices?.[0]?.delta?.content;
          if (delta) {
            full += delta;
            onDelta(delta);
          }
        } catch {
          /* keep-alive / partial frame */
        }
      }
    }
    return full;
  }

  private async chatViaRequestUrl(
    url: string,
    req: ChatRequest,
    onDelta: (chunk: string) => void,
  ): Promise<string> {
    const res = await requestUrl({
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ messages: req.messages, stream: false }),
      throw: false,
    });
    if (res.status >= 400) {
      throw new Error(await describeError(res.status, async () => res.text));
    }
    const full: string = res.json?.choices?.[0]?.message?.content ?? "";
    if (full) onDelta(full);
    return full;
  }
}

async function describeError(status: number, readBody: () => Promise<string> | string): Promise<string> {
  let detail = "";
  let checkoutUrl = "";
  try {
    const text = await readBody();
    const parsed = JSON.parse(text);
    detail = parsed.error ?? "";
    checkoutUrl = parsed.checkoutUrl ?? "";
  } catch {
    /* non-JSON body */
  }
  if (status === 401) return "Session expired — sign in again in ZettelkastenAI settings.";
  if (status === 402) return `${detail || "Free messages used up"}. Subscribe: ${checkoutUrl || "see settings"}`;
  if (status === 503) return detail || "Hosted model is temporarily unavailable.";
  return `ZettelkastenAI backend HTTP ${status}: ${detail}`;
}

// ---------- account API used by the settings tab ----------

export async function requestCode(backendUrl: string, email: string): Promise<void> {
  const res = await requestUrl({
    url: backendUrl.replace(/\/+$/, "") + "/api/auth/request-code",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
    throw: false,
  });
  if (res.status >= 400) throw new Error(res.json?.error ?? `HTTP ${res.status}`);
}

export async function verifyCode(backendUrl: string, email: string, code: string): Promise<string> {
  const res = await requestUrl({
    url: backendUrl.replace(/\/+$/, "") + "/api/auth/verify",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, code }),
    throw: false,
  });
  if (res.status >= 400) throw new Error(res.json?.error ?? `HTTP ${res.status}`);
  return res.json.token as string;
}

export async function fetchAccount(backendUrl: string, token: string): Promise<AccountInfo> {
  const res = await requestUrl({
    url: backendUrl.replace(/\/+$/, "") + "/api/me",
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    throw: false,
  });
  if (res.status >= 400) throw new Error(res.json?.error ?? `HTTP ${res.status}`);
  return res.json as AccountInfo;
}
