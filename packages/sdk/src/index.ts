import { ProductDemoClient, type ProductDemoClientOptions } from "./client.js";
import { ProductDemoApiError, ProductDemoError } from "./errors.js";
import { parseSessionEvent, type CreateResponse, type DemoEvent } from "./protocol.js";

export {
  ProductDemoClient,
  type CreateDemoOptions,
  type ProductDemoClientOptions
} from "./client.js";
export {
  ProductDemoApiError,
  ProductDemoError,
  isProductDemoError,
  type ProductDemoErrorCode
} from "./errors.js";
export type { CreateResponse, DemoEvent } from "./protocol.js";

const styles = `
:host{--pd-bg:#0b1020;--pd-fg:#f8fafc;--pd-accent:#2563eb;--pd-muted:#aab2c5;display:inline-block;font:14px/1.45 ui-sans-serif,system-ui,sans-serif;color:var(--pd-fg)}:host([external-trigger]){display:none}button,input{font:inherit}.launch{border:0;border-radius:10px;padding:11px 18px;background:var(--pd-accent);color:#fff;font-weight:700;cursor:pointer}.launch:focus-visible,.close:focus-visible,input:focus-visible,.send:focus-visible{outline:3px solid #a5b4fc;outline-offset:2px}.shell[hidden]{display:none}.shell{position:fixed;inset:0;z-index:2147483000;background:#020617c7;display:grid;place-items:center;padding:20px}.panel{width:min(1180px,100%);height:min(780px,calc(100dvh - 40px));background:var(--pd-bg);border:1px solid #26304a;border-radius:16px;box-shadow:0 24px 80px #0009;overflow:hidden;display:grid;grid-template-rows:auto 1fr auto}.top{display:flex;align-items:center;gap:12px;padding:12px 14px;border-bottom:1px solid #26304a}.title{font-weight:750;flex:1}.status{color:var(--pd-muted);font-size:13px}.close{border:0;background:transparent;color:var(--pd-fg);font-size:24px;cursor:pointer}.stage{position:relative;min-height:0}.stage iframe{width:100%;height:100%;border:0;background:#fff}.empty{position:absolute;inset:0;display:grid;place-items:center;text-align:center;padding:28px;color:var(--pd-muted)}.composer{display:flex;gap:8px;padding:10px;border-top:1px solid #26304a}.composer input{min-width:0;flex:1;border:1px solid #3a4665;border-radius:9px;background:#11182b;color:var(--pd-fg);padding:9px 11px}.send{border:0;border-radius:9px;background:#26304a;color:var(--pd-fg);padding:8px 14px;cursor:pointer}.goal{position:absolute;inset:0;display:grid;place-items:center;background:var(--pd-bg);padding:24px}.goal[hidden]{display:none}.goal form{width:min(520px,100%)}.goal h2{margin:0 0 8px;font-size:24px}.goal p{color:var(--pd-muted)}.goal input{box-sizing:border-box;width:100%;border:1px solid #3a4665;border-radius:10px;background:#11182b;color:var(--pd-fg);padding:12px;margin:8px 0 12px}.goal button{width:100%;border:0;border-radius:10px;background:var(--pd-accent);color:#fff;padding:12px;font-weight:700;cursor:pointer}@media(max-width:640px){.shell{padding:0}.panel{width:100%;height:100dvh;border-radius:0;border:0}.status{max-width:45%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}
`;

export interface ProductDemoElementOptions extends ProductDemoClientOptions {
  getChallengeToken?: () => Promise<string | undefined>;
  locale?: string;
}

// The fallback keeps the ESM entry importable during server rendering.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
const HTMLElementBase = (globalThis.HTMLElement ?? class {}) as typeof HTMLElement;

export class ProductDemoElement extends HTMLElementBase {
  public getChallengeToken: (() => Promise<string | undefined>) | undefined;
  public locale: string | undefined;
  readonly #root: ShadowRoot;
  #client: ProductDemoClient | undefined;
  #controller: AbortController | undefined;
  #session: CreateResponse | undefined;
  #startPromise: Promise<void> | undefined;
  #lastSequence = 0;
  #terminal = false;
  #initialized = false;
  #generation = 0;
  #previousFocus: HTMLElement | undefined;
  #previousOverflow = "";

  public constructor() {
    super();
    this.#root = this.attachShadow({ mode: "closed" });
    this.#root.innerHTML = `<style>${styles}</style><button class="launch" type="button"><slot>See AI demo</slot></button><div class="shell" hidden role="dialog" aria-modal="true" aria-labelledby="pd-title" aria-describedby="pd-status"><section class="panel"><header class="top"><span class="title" id="pd-title">Live AI product demo</span><span class="status" id="pd-status" role="status" aria-live="polite">Ready</span><button class="close" type="button" aria-label="Close demo">×</button></header><main class="stage"><div class="empty">Preparing your secure live browser…</div><div class="goal"><form><h2>What would you like to see?</h2><p>The AI will demonstrate that workflow in a live demo environment.</p><input required minlength="3" maxlength="1000" autocomplete="off" aria-label="Demo goal" placeholder="For example: show me how analytics filters work"><button type="submit">Start live demo</button></form></div></main><form class="composer"><input aria-label="Send an update" maxlength="1000" autocomplete="off" placeholder="Ask the demo to show something else"><button class="send" type="submit">Send</button></form></section></div>`;
  }

  public connectedCallback(): void {
    if (this.#initialized) return;
    this.#initialized = true;
    this.button(".launch").addEventListener("click", () => this.open());
    this.button(".close").addEventListener("click", () => void this.close());
    this.#root.querySelector(".goal form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.start(this.input(".goal input").value);
    });
    this.#root.querySelector(".composer")?.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.sendMessage();
    });
    this.element<HTMLElement>(".shell").addEventListener("keydown", (event) =>
      this.handleDialogKey(event)
    );
  }

  public disconnectedCallback(): void {
    this.#controller?.abort();
    this.restorePage();
  }

  public configure(options: ProductDemoElementOptions): this {
    if (this.#session || this.#startPromise)
      throw new ProductDemoError("Cannot reconfigure an active demo", {
        code: "configuration_error"
      });
    this.setAttribute("api-url", options.apiUrl);
    this.setAttribute("integration-id", options.integrationId);
    this.getChallengeToken = options.getChallengeToken;
    this.locale = options.locale;
    this.#client = new ProductDemoClient(options);
    return this;
  }

  public open(): void {
    const shell = this.element<HTMLElement>(".shell");
    if (!shell.hidden) return;
    this.#previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    this.#previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    shell.hidden = false;
    this.input(".goal input").focus();
    this.emit("product-demo:open", {});
  }

  public start(goal: string, turnstileToken?: string): Promise<void> {
    if (this.#startPromise) return this.#startPromise;
    const promise = this.startOnce(goal, turnstileToken).finally(() => {
      if (this.#startPromise === promise) this.#startPromise = undefined;
    });
    this.#startPromise = promise;
    return promise;
  }

  public async close(): Promise<void> {
    const generation = ++this.#generation;
    this.#controller?.abort();
    const session = this.#session;
    const client = this.#client;
    this.#session = undefined;
    this.#terminal = true;
    this.#lastSequence = 0;
    this.element<HTMLElement>(".shell").hidden = true;
    this.element<HTMLElement>(".empty").hidden = false;
    this.element<HTMLElement>(".goal").hidden = false;
    this.#root.querySelector("iframe")?.remove();
    this.restorePage();
    if (session && client)
      await client.cancel(session, true).catch(() => {
        // The server expires abandoned sessions; closing the host UI must remain reliable.
      });
    if (generation === this.#generation) this.setStatus("Ready");
    this.emit("product-demo:close", {});
  }

  public async sendMessage(message?: string): Promise<void> {
    if (!this.#session || !this.#client || this.#terminal) return;
    const input = this.input(".composer input");
    const value = (message ?? input.value).trim();
    if (!value) return;
    try {
      await this.#client.sendMessage(this.#session, value, this.#controller?.signal);
      if (message === undefined) input.value = "";
    } catch (error) {
      this.reportError(error, "Could not send that update");
    }
  }

  private async startOnce(goal: string, turnstileToken?: string): Promise<void> {
    const normalizedGoal = goal.trim();
    if (normalizedGoal.length < 3 || normalizedGoal.length > 1_000) {
      this.reportError(
        new ProductDemoError("Enter a goal between 3 and 1000 characters", {
          code: "configuration_error"
        }),
        "Enter a valid demo goal"
      );
      return;
    }
    const generation = ++this.#generation;
    const client = this.client();
    this.open();
    this.setStatus("Starting secure browser…");
    this.button(".goal button").disabled = true;
    this.#lastSequence = 0;
    this.#terminal = false;
    this.#controller?.abort();
    const controller = new AbortController();
    this.#controller = controller;
    try {
      const challenge = turnstileToken ?? (await this.getChallengeToken?.());
      const session = await client.create({
        goal: normalizedGoal,
        ...(this.locale ? { locale: this.locale } : {}),
        ...(challenge ? { turnstileToken: challenge } : {}),
        signal: controller.signal
      });
      if (generation !== this.#generation) {
        await client.cancel(session, true).catch(() => undefined);
        return;
      }
      this.#session = session;
      this.element<HTMLElement>(".goal").hidden = true;
      this.emit("product-demo:start", { sessionId: session.sessionId });
      await this.consumeEvents(session, controller.signal, generation);
    } catch (error) {
      if (!controller.signal.aborted) this.reportError(error, "Could not start the demo");
    } finally {
      this.button(".goal button").disabled = false;
    }
  }

  private async consumeEvents(
    session: CreateResponse,
    signal: AbortSignal,
    generation: number
  ): Promise<void> {
    let attempt = 0;
    while (
      !signal.aborted &&
      !this.#terminal &&
      generation === this.#generation &&
      Date.now() < Date.parse(session.expiresAt)
    ) {
      try {
        const response = await this.client().eventStream(session, this.#lastSequence, signal);
        if (!response.body)
          throw new ProductDemoError("Event stream has no body", { code: "invalid_response" });
        attempt = 0;
        await this.readStream(response.body, session.sessionId, signal);
      } catch (error) {
        if (signal.aborted || this.#terminal) return;
        if (
          (error instanceof ProductDemoApiError && [401, 403, 404].includes(error.status ?? 0)) ||
          (error instanceof ProductDemoError && error.code === "invalid_response")
        ) {
          this.reportError(error, "The live connection stopped");
          this.#terminal = true;
          return;
        }
        this.setStatus("Reconnecting…");
        await delay(Math.min(10_000, 500 * 2 ** Math.min(attempt++, 5)), signal);
      }
    }
    if (!signal.aborted && !this.#terminal && Date.now() >= Date.parse(session.expiresAt)) {
      this.#terminal = true;
      this.setStatus("Demo expired");
    }
  }

  private async readStream(
    body: ReadableStream<Uint8Array>,
    expectedSessionId: string,
    signal: AbortSignal
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const abortReader = () => void reader.cancel(signal.reason).catch(() => undefined);
    signal.addEventListener("abort", abortReader, { once: true });
    try {
      while (!signal.aborted && !this.#terminal) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 262_144)
          throw new ProductDemoError("Event stream buffer exceeded its limit", {
            code: "invalid_response"
          });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          if (block.length > 65_536)
            throw new ProductDemoError("Event stream event exceeded its limit", {
              code: "invalid_response"
            });
          const data = block
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          let event: DemoEvent;
          try {
            event = parseSessionEvent(JSON.parse(data));
          } catch (cause) {
            throw new ProductDemoError("Invalid event from demo service", {
              code: "invalid_response",
              cause
            });
          }
          if (event.sessionId !== expectedSessionId)
            throw new ProductDemoError("Event belongs to another session", {
              code: "invalid_response"
            });
          if (event.sequence <= this.#lastSequence) continue;
          this.handleEvent(event);
        }
      }
    } finally {
      signal.removeEventListener("abort", abortReader);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  private handleEvent(event: DemoEvent): void {
    this.#lastSequence = event.sequence;
    const labels: Record<string, string> = {
      "session.starting": "Starting browser…",
      "session.viewer_ready": "Browser ready",
      "session.running": "AI is demonstrating",
      "session.completed": "Demo complete",
      "session.failed": "Demo stopped",
      "session.cancelled": "Demo cancelled",
      "session.expired": "Demo expired"
    };
    const label = labels[event.type];
    if (label) this.setStatus(label);
    if (event.type === "session.viewer_ready") void this.attachViewer(this.#generation);
    if (event.type === "agent.narration")
      this.setStatus(
        typeof event.data.message === "string" ? event.data.message : "AI is demonstrating"
      );
    if (
      ["session.completed", "session.failed", "session.cancelled", "session.expired"].includes(
        event.type
      )
    )
      this.#terminal = true;
    this.emit("product-demo:event", event);
  }

  private async attachViewer(generation: number): Promise<void> {
    const session = this.#session;
    if (!session || this.#root.querySelector("iframe")) return;
    try {
      const viewerUrl = await this.client().getViewer(session, this.#controller?.signal);
      if (
        generation !== this.#generation ||
        this.#session !== session ||
        this.#terminal ||
        this.#root.querySelector("iframe")
      )
        return;
      const iframe = document.createElement("iframe");
      iframe.title = "Live AI-controlled product browser";
      iframe.referrerPolicy = "no-referrer";
      iframe.sandbox.add("allow-scripts", "allow-same-origin", "allow-forms", "allow-pointer-lock");
      iframe.src = viewerUrl;
      this.element<HTMLElement>(".empty").hidden = true;
      this.element<HTMLElement>(".stage").prepend(iframe);
    } catch (error) {
      if (!this.#controller?.signal.aborted) this.reportError(error, "Browser view is unavailable");
    }
  }

  private client(): ProductDemoClient {
    if (!this.#client)
      this.#client = new ProductDemoClient({
        apiUrl: this.requiredAttribute("api-url"),
        integrationId: this.requiredAttribute("integration-id")
      });
    return this.#client;
  }

  private handleDialogKey(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      void this.close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [
      ...this.#root.querySelectorAll<HTMLElement>("button:not([disabled]),input")
    ].filter((element) => !element.closest("[hidden]"));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && this.#root.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && this.#root.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  private restorePage(): void {
    if (typeof document === "undefined") return;
    document.documentElement.style.overflow = this.#previousOverflow;
    this.#previousFocus?.focus();
    this.#previousFocus = undefined;
  }

  private reportError(error: unknown, fallback: string): void {
    const message = error instanceof ProductDemoError ? error.message : fallback;
    this.setStatus(message);
    this.emit("product-demo:error", {
      message,
      ...(error instanceof ProductDemoError
        ? { code: error.code, status: error.status, requestId: error.requestId }
        : {})
    });
  }

  private setStatus(message: string): void {
    this.element<HTMLElement>(".status").textContent = message.slice(0, 500);
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
    if (!value)
      throw new ProductDemoError(`Missing ${name} attribute`, { code: "configuration_error" });
    return value;
  }
  private emit(name: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }
}

export interface ProductDemoMountOptions extends ProductDemoElementOptions {
  trigger: string | HTMLElement;
}

export class ProductDemo {
  public readonly element: ProductDemoElement;
  readonly #trigger: HTMLElement;
  readonly #open: () => void;

  private constructor(element: ProductDemoElement, trigger: HTMLElement) {
    this.element = element;
    this.#trigger = trigger;
    this.#open = () => element.open();
    trigger.addEventListener("click", this.#open);
  }

  public static mount(options: ProductDemoMountOptions): ProductDemo {
    if (typeof document === "undefined")
      throw new ProductDemoError("ProductDemo.mount requires a browser document", {
        code: "configuration_error"
      });
    const trigger =
      typeof options.trigger === "string"
        ? document.querySelector<HTMLElement>(options.trigger)
        : options.trigger;
    if (!trigger)
      throw new ProductDemoError("Demo trigger was not found", { code: "configuration_error" });
    const element = document.createElement("ai-product-demo") as ProductDemoElement;
    element.setAttribute("external-trigger", "");
    element.configure(options);
    document.body.append(element);
    return new ProductDemo(element, trigger);
  }

  public open(): void {
    this.element.open();
  }
  public start(goal: string, turnstileToken?: string): Promise<void> {
    return this.element.start(goal, turnstileToken);
  }
  public close(): Promise<void> {
    return this.element.close();
  }
  public sendMessage(message: string): Promise<void> {
    return this.element.sendMessage(message);
  }
  public on(name: string, listener: EventListenerOrEventListenerObject): () => void {
    this.element.addEventListener(name, listener);
    return () => this.element.removeEventListener(name, listener);
  }
  public async destroy(): Promise<void> {
    this.#trigger.removeEventListener("click", this.#open);
    await this.close();
    this.element.remove();
  }
}

export function mount(options: ProductDemoMountOptions): ProductDemo {
  return ProductDemo.mount(options);
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error("Demo aborted"));
      },
      { once: true }
    );
  });
}

if (typeof customElements !== "undefined" && !customElements.get("ai-product-demo"))
  customElements.define("ai-product-demo", ProductDemoElement);
