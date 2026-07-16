import {
  parseCreateSessionResponse,
  parseSessionEvent,
  parseViewResponse,
  type CreateResponse,
  type DemoEvent
} from "./protocol.js";

const styles = `
:host{--pd-bg:#0b1020;--pd-fg:#f8fafc;--pd-accent:#6d5dfc;--pd-muted:#aab2c5;display:inline-block;font:14px/1.45 ui-sans-serif,system-ui,sans-serif;color:var(--pd-fg)}button,input{font:inherit}.launch{border:0;border-radius:10px;padding:11px 18px;background:var(--pd-accent);color:#fff;font-weight:700;cursor:pointer}.launch:focus-visible,.close:focus-visible,input:focus-visible{outline:3px solid #a5b4fc;outline-offset:2px}.shell[hidden]{display:none}.shell{position:fixed;inset:0;z-index:2147483000;background:#020617b8;display:grid;place-items:center;padding:20px}.panel{width:min(1180px,100%);height:min(780px,calc(100vh - 40px));background:var(--pd-bg);border:1px solid #26304a;border-radius:16px;box-shadow:0 24px 80px #0009;overflow:hidden;display:grid;grid-template-rows:auto 1fr auto}.top{display:flex;align-items:center;gap:12px;padding:12px 14px;border-bottom:1px solid #26304a}.title{font-weight:750;flex:1}.status{color:var(--pd-muted);font-size:13px}.close{border:0;background:transparent;color:var(--pd-fg);font-size:24px;cursor:pointer}.stage{position:relative;min-height:0}.stage iframe{width:100%;height:100%;border:0;background:#fff}.empty{position:absolute;inset:0;display:grid;place-items:center;text-align:center;padding:28px;color:var(--pd-muted)}.composer{display:flex;gap:8px;padding:10px;border-top:1px solid #26304a}.composer input{min-width:0;flex:1;border:1px solid #3a4665;border-radius:9px;background:#11182b;color:var(--pd-fg);padding:9px 11px}.composer button{border:0;border-radius:9px;background:#26304a;color:var(--pd-fg);padding:8px 14px;cursor:pointer}.goal{position:absolute;inset:0;display:grid;place-items:center;background:var(--pd-bg);padding:24px}.goal[hidden]{display:none}.goal form{width:min(520px,100%)}.goal h2{margin:0 0 8px;font-size:24px}.goal p{color:var(--pd-muted)}.goal input{box-sizing:border-box;width:100%;border:1px solid #3a4665;border-radius:10px;background:#11182b;color:var(--pd-fg);padding:12px;margin:8px 0 12px}.goal button{width:100%;border:0;border-radius:10px;background:var(--pd-accent);color:#fff;padding:12px;font-weight:700;cursor:pointer}@media(max-width:640px){.shell{padding:0}.panel{width:100%;height:100vh;border-radius:0;border:0}.status{display:none}}
`;

export class ProductDemoElement extends HTMLElement {
  public getChallengeToken?: () => Promise<string | undefined>;
  readonly #root: ShadowRoot;
  #controller?: AbortController;
  #session: CreateResponse | undefined;
  #lastSequence = 0;
  #terminal = false;
  #initialized = false;

  public constructor() {
    super();
    this.#root = this.attachShadow({ mode: "closed" });
    this.#root.innerHTML = `<style>${styles}</style><button class="launch" type="button"><slot>See AI demo</slot></button><div class="shell" hidden role="dialog" aria-modal="true" aria-label="Live product demo"><section class="panel"><header class="top"><span class="title">Live AI product demo</span><span class="status" role="status">Ready</span><button class="close" type="button" aria-label="Close demo">×</button></header><main class="stage"><div class="empty">Preparing your secure live browser…</div><div class="goal"><form><h2>What would you like to see?</h2><p>The AI will demonstrate that workflow in a live demo environment.</p><input required minlength="3" maxlength="1000" autocomplete="off" placeholder="For example: show me how analytics filters work"><button type="submit">Start live demo</button></form></div></main><footer class="composer"><input aria-label="Send an update" maxlength="1000" placeholder="Ask the demo to show something else"><button type="button">Send</button></footer></section></div>`;
  }

  public connectedCallback(): void {
    if (this.#initialized) return;
    this.#initialized = true;
    this.button(".launch").addEventListener("click", () => this.open());
    this.button(".close").addEventListener("click", () => void this.close());
    this.#root.querySelector("form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.start(this.input(".goal input").value);
    });
    this.button(".composer button").addEventListener("click", () => void this.sendMessage());
  }

  public disconnectedCallback(): void {
    this.#controller?.abort();
  }

  public open(): void {
    this.element<HTMLElement>(".shell").hidden = false;
    this.input(".goal input").focus();
    this.emit("product-demo:open", {});
  }

  public async start(goal: string, turnstileToken?: string): Promise<void> {
    const apiUrl = this.requiredAttribute("api-url").replace(/\/$/, "");
    const integrationId = this.requiredAttribute("integration-id");
    this.open();
    this.setStatus("Starting secure browser…");
    this.button(".goal button").disabled = true;
    this.#lastSequence = 0;
    this.#terminal = false;
    try {
      const challenge = turnstileToken ?? (await this.getChallengeToken?.());
      const response = await fetch(
        `${apiUrl}/v1/integrations/${encodeURIComponent(integrationId)}/sessions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({ goal, ...(challenge ? { turnstileToken: challenge } : {}) })
        }
      );
      if (!response.ok) throw new Error(await safeApiError(response));
      this.#session = parseCreateSessionResponse(await response.json());
      this.element<HTMLElement>(".goal").hidden = true;
      this.#controller = new AbortController();
      this.emit("product-demo:start", { sessionId: this.#session.sessionId });
      await this.consumeEvents(this.#controller.signal);
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : "Could not start the demo");
      this.emit("product-demo:error", {
        message: error instanceof Error ? error.message : "Unknown error"
      });
    } finally {
      this.button(".goal button").disabled = false;
    }
  }

  public async close(): Promise<void> {
    this.#controller?.abort();
    if (this.#session)
      await this.authFetch(`/v1/sessions/${this.#session.sessionId}`, {
        method: "DELETE",
        keepalive: true
      }).catch(() => undefined);
    this.element<HTMLElement>(".shell").hidden = true;
    this.element<HTMLElement>(".empty").hidden = false;
    this.#root.querySelector("iframe")?.remove();
    this.#session = undefined;
    this.#terminal = true;
    this.emit("product-demo:close", {});
  }

  private async consumeEvents(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && this.#session && !this.#terminal) {
      try {
        const response = await fetch(this.#session.eventsUrl, {
          headers: {
            Authorization: `Bearer ${this.#session.accessToken}`,
            "Last-Event-ID": String(this.#lastSequence)
          },
          signal
        });
        if (!response.ok || !response.body) throw new Error("Event stream unavailable");
        await this.readStream(response.body, signal);
      } catch {
        if (signal.aborted) return;
        this.setStatus("Reconnecting…");
        await delay(1_000, signal);
      }
    }
  }

  private async readStream(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const data = block
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice(6);
          if (data) this.handleEvent(parseSessionEvent(JSON.parse(data)));
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private handleEvent(event: DemoEvent): void {
    this.#lastSequence = Math.max(this.#lastSequence, event.sequence);
    const labels: Record<string, string> = {
      "session.starting": "Starting browser…",
      "session.viewer_ready": "Browser ready",
      "session.running": "AI is demonstrating",
      "session.completed": "Demo complete",
      "session.failed": "Demo stopped",
      "session.cancelled": "Demo cancelled"
    };
    const label = labels[event.type];
    if (label) this.setStatus(label);
    if (event.type === "session.viewer_ready") void this.attachViewer();
    if (event.type === "agent.narration") {
      const message = event.data.message;
      this.setStatus(typeof message === "string" ? message : "AI is demonstrating");
    }
    if (
      ["session.completed", "session.failed", "session.cancelled", "session.expired"].includes(
        event.type
      )
    ) {
      this.#terminal = true;
    }
    this.emit("product-demo:event", event);
  }

  private async attachViewer(): Promise<void> {
    if (!this.#session) return;
    const response = await this.authFetch(`/v1/sessions/${this.#session.sessionId}/view`);
    if (!response.ok) return;
    const { viewerUrl } = parseViewResponse(await response.json());
    const iframe = document.createElement("iframe");
    iframe.title = "Live AI-controlled product browser";
    iframe.allow = "clipboard-read; clipboard-write";
    iframe.referrerPolicy = "no-referrer";
    iframe.sandbox.add("allow-scripts", "allow-same-origin", "allow-forms", "allow-pointer-lock");
    iframe.src = viewerUrl;
    this.element<HTMLElement>(".empty").hidden = true;
    this.element<HTMLElement>(".stage").prepend(iframe);
  }

  private async sendMessage(): Promise<void> {
    if (!this.#session) return;
    const input = this.input(".composer input");
    const message = input.value.trim();
    if (!message) return;
    const response = await this.authFetch(`/v1/sessions/${this.#session.sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message })
    });
    if (response.ok) input.value = "";
  }

  private authFetch(path: string, init: RequestInit = {}): Promise<Response> {
    if (!this.#session) throw new Error("No active session");
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.#session.accessToken}`);
    return fetch(`${this.requiredAttribute("api-url").replace(/\/$/, "")}${path}`, {
      ...init,
      headers
    });
  }

  private setStatus(message: string): void {
    this.element<HTMLElement>(".status").textContent = message;
  }
  private input(selector: string): HTMLInputElement {
    return this.element<HTMLInputElement>(selector);
  }
  private button(selector: string): HTMLButtonElement {
    return this.element<HTMLButtonElement>(selector);
  }
  private element<T extends Element>(selector: string): T {
    const found = this.#root.querySelector<T>(selector);
    if (!found) throw new Error(`Missing UI element: ${selector}`);
    return found;
  }
  private requiredAttribute(name: string): string {
    const value = this.getAttribute(name);
    if (!value) throw new Error(`Missing ${name} attribute`);
    return value;
  }
  private emit(name: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }
}

async function safeApiError(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { error?: string };
    return data.error?.replaceAll("_", " ") ?? `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}
function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
      },
      { once: true }
    );
  });
}
if (!customElements.get("ai-product-demo"))
  customElements.define("ai-product-demo", ProductDemoElement);
