import { Platform, requestUrl } from "obsidian";
import { ChatRequest, CompletionRequest, CompletionResult, LLMProvider } from "./types";
import { completeWithTools } from "./openaiTools";

export interface AccountInfo {
  email: string;
  used: number;
  freeQuota: number;
  pro: boolean;
  proUntil: string | null;
  checkoutUrl: string;
}

/** A short-lived GLM credential for Pro users: chat goes client → Z.ai
 *  directly, our backend only controls the subscription. */
export interface Lease {
  baseUrl: string;
  apiKey: string;
  model: string;
  fastModel: string;
  exp: number;
}

/**
 * Hosted subscription provider. Free tier is proxied through our control
 * plane (the key never reaches the client). Pro accounts fetch a lease and
 * talk to Z.ai directly — no chat traffic through our server.
 */
export class HostedProvider implements LLMProvider {
  id = "hosted";
  supportsMobile = true;

  private lease: Lease | null = null;
  private leaseDeniedAt = 0; // last 402 — don't re-ask for a few minutes

  constructor(
    private backendUrl: string,
    private token: string,
  ) {}

  private async ensureLease(): Promise<Lease | null> {
    if (this.lease && this.lease.exp > Date.now() + 60_000) return this.lease;
    if (Date.now() - this.leaseDeniedAt < 5 * 60_000) return null;
    try {
      const res = await requestUrl({
        url: this.backendUrl.replace(/\/+$/, "") + "/api/lease",
        method: "GET",
        headers: { Authorization: `Bearer ${this.token}` },
        throw: false,
      });
      if (res.status === 200 && res.json?.apiKey) {
        this.lease = res.json as Lease;
        return this.lease;
      }
    } catch {
      /* network — fall back to proxy */
    }
    this.leaseDeniedAt = Date.now();
    return null;
  }

  private leaseModel(lease: Lease, tier?: string): string {
    return tier === "fast" ? lease.fastModel : lease.model;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    if (!this.token) throw new Error("Sign in first: ZettelkastenAI settings → Account → Sign in in browser.");
    const lease = await this.ensureLease();
    if (lease) {
      try {
        return await completeWithTools(
          lease.baseUrl + "/chat/completions",
          { Authorization: `Bearer ${lease.apiKey}` },
          this.leaseModel(lease, req.model),
          req,
        );
      } catch (e) {
        if (/Auth failed|401/.test(e instanceof Error ? e.message : "")) this.lease = null; // key rotated → re-lease / proxy
        else throw e;
      }
    }
    const url = this.backendUrl.replace(/\/+$/, "") + "/api/chat";
    return completeWithTools(
      url,
      { Authorization: `Bearer ${this.token}` },
      req.model ?? "",
      req,
      { "X-ZK-Turn": req.firstOfTurn ? "new" : "continue" },
    );
  }

  /** Direct Z.ai call (Pro lease). requestUrl → no CORS, but no streaming:
   *  the full answer arrives in one delta. */
  private async chatDirect(lease: Lease, req: ChatRequest, onDelta: (chunk: string) => void): Promise<string> {
    const res = await requestUrl({
      url: lease.baseUrl + "/chat/completions",
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${lease.apiKey}` },
      body: JSON.stringify({ model: this.leaseModel(lease, req.model), messages: req.messages, stream: false }),
      throw: false,
    });
    if (res.status === 401) {
      this.lease = null;
      throw new Error("lease-auth");
    }
    if (res.status >= 400) {
      const detail = res.json?.error?.message ?? res.json?.error ?? "";
      if (res.status === 429) throw new Error(detail || "GLM usage limit reached for this cycle — try Low effort or wait a bit.");
      throw new Error(`Model HTTP ${res.status}: ${detail}`);
    }
    const full: string = res.json?.choices?.[0]?.message?.content ?? "";
    if (full) onDelta(full);
    return full;
  }

  async chat(req: ChatRequest, onDelta: (chunk: string) => void): Promise<string> {
    if (!this.token) {
      throw new Error("Sign in first: ZettelkastenAI settings → Account → Sign in in browser.");
    }
    const lease = await this.ensureLease();
    if (lease) {
      try {
        return await this.chatDirect(lease, req, onDelta);
      } catch (e) {
        if (!(e instanceof Error && e.message === "lease-auth")) throw e;
        /* key rotated → fall through to the proxy path */
      }
    }
    const url = this.backendUrl.replace(/\/+$/, "") + "/api/chat";

    const payload = JSON.stringify({ messages: req.messages, ...(req.model ? { model: req.model } : {}), stream: true });
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` },
        body: payload,
        signal: req.signal,
      });
    } catch (e) {
      if (req.signal?.aborted) throw e;
      // Network blip (e.g. Wi-Fi/VPN change → ERR_NETWORK_CHANGED) or mobile:
      // retry once via requestUrl (non-streamed), which is more robust.
      return this.chatViaRequestUrl(url, req, onDelta);
    }
    if (!res.ok || !res.body) {
      throw await describeError(res.status, () => res.text());
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let full = "";
    let buf = "";
    try {
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
    } catch (e) {
      // Stream cut mid-flight (network change). If nothing arrived yet, retry
      // non-streamed; otherwise return what we have.
      if (req.signal?.aborted) throw e;
      if (!full) return this.chatViaRequestUrl(url, req, onDelta);
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
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ messages: req.messages, ...(req.model ? { model: req.model } : {}), stream: false }),
      throw: false,
    });
    if (res.status >= 400) {
      throw await describeError(res.status, async () => res.text);
    }
    const full: string = res.json?.choices?.[0]?.message?.content ?? "";
    if (full) onDelta(full);
    return full;
  }
}

/** Error carrying an optional checkoutUrl so the UI can render a short link. */
export class ChatError extends Error {
  constructor(message: string, readonly checkoutUrl?: string) {
    super(message);
  }
}

async function describeError(status: number, readBody: () => Promise<string> | string): Promise<ChatError> {
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
  if (status === 401) return new ChatError("Session expired — sign in again in ZettelkastenAI settings.");
  if (status === 402) return new ChatError(detail?.replace(/\.?\s*Subscribe:.*$/i, "") || "Free messages used up.", checkoutUrl);
  if (status === 503) return new ChatError(detail || "Hosted model is temporarily unavailable.");
  return new ChatError(`ZettelkastenAI backend HTTP ${status}: ${detail}`);
}

// ---------- account API used by the settings tab ----------

/** Starts the browser sign-in: returns a device code and the URL to open. */
export async function deviceStart(backendUrl: string): Promise<{ device: string; url: string }> {
  const res = await requestUrl({
    url: backendUrl.replace(/\/+$/, "") + "/api/device/start",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    throw: false,
  });
  if (res.status >= 400) throw new Error(res.json?.error ?? `HTTP ${res.status}`);
  return res.json as { device: string; url: string };
}

/** Polls until the user finishes signing in in the browser; resolves with the JWT. */
export async function devicePoll(backendUrl: string, device: string, timeoutMs = 600_000, signal?: { cancelled: boolean }): Promise<string> {
  const url = backendUrl.replace(/\/+$/, "") + "/api/device/poll";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.cancelled) throw new Error("Sign-in cancelled");
    await new Promise((r) => window.setTimeout(r, 2500));
    const res = await requestUrl({
      url,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device }),
      throw: false,
    });
    if (res.status === 410) throw new Error("Sign-in session expired — try again");
    if (res.status >= 400) continue; // transient
    if (res.json?.token) return res.json.token as string;
  }
  throw new Error("Sign-in timed out — try again");
}

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
