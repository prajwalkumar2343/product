import { ProductDemoClient } from "./client.js";
import { productDemoTemplate } from "./element-view.js";
import { ProductDemoApiError, ProductDemoError } from "./errors.js";
import {
  parseFocusEventData,
  parseSessionEvent,
  type CreateResponse,
  type DemoEvent
} from "./protocol.js";

export interface ProductDemoElementOptions {
  client: ProductDemoClient;
  integrationId: string;
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
  #startPromise: Promise<{ sessionId: string }> | undefined;
  #closePromise: Promise<void> | undefined;
  #focusTimer: ReturnType<typeof setTimeout> | undefined;
  #lastSequence = 0;
  #terminal = false;
  #initialized = false;
  #generation = 0;
  #previousFocus: HTMLElement | undefined;
  #previousOverflow = "";

  public constructor() {
    super();
    this.#root = this.attachShadow({ mode: "closed" });
    this.#root.innerHTML = productDemoTemplate;
    this.dataset.status = "idle";
  }

  public connectedCallback(): void {
    if (this.#initialized) return;
    this.#initialized = true;
    this.button(".launch").addEventListener("click", () => this.open());
    this.button(".close").addEventListener("click", () => void this.close());
    this.#root.querySelector(".goal form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.start(this.input(".goal input").value).catch(() => undefined);
    });
    this.#root.querySelector(".composer")?.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.sendMessage().catch(() => undefined);
    });
    this.element<HTMLElement>(".shell").addEventListener("keydown", (event) =>
      this.handleDialogKey(event)
    );
  }

  public disconnectedCallback(): void {
    this.#controller?.abort();
    this.resetFocus();
    this.restorePage();
  }

  public configure(options: ProductDemoElementOptions): this {
    if (this.#session || this.#startPromise)
      throw new ProductDemoError("Cannot reconfigure an active demo", {
        code: "configuration_error"
      });
    this.setAttribute("integration-id", options.integrationId);
    this.getChallengeToken = options.getChallengeToken;
    this.locale = options.locale;
    this.#client = options.client;
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
    shell.dataset.open = "false";
    requestAnimationFrame(() => {
      if (!shell.hidden) shell.dataset.open = "true";
    });
    this.clearNotice();
    this.input(".goal input").focus();
    this.emit("product-demo:open", undefined);
  }

  public start(goal: string, turnstileToken?: string): Promise<{ sessionId: string }> {
    if (this.#startPromise) return this.#startPromise;
    if (this.#session)
      return Promise.reject(
        new ProductDemoError("A demo is already active; close it before starting another", {
          code: "configuration_error"
        })
      );
    const promise = this.startOnce(goal, turnstileToken).finally(() => {
      if (this.#startPromise === promise) this.#startPromise = undefined;
    });
    this.#startPromise = promise;
    return promise;
  }

  public close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    const promise = this.closeOnce().finally(() => {
      if (this.#closePromise === promise) this.#closePromise = undefined;
    });
    this.#closePromise = promise;
    return promise;
  }

  private async closeOnce(): Promise<void> {
    const shell = this.element<HTMLElement>(".shell");
    if (shell.hidden && !this.#session && !this.#startPromise) return;
    const generation = ++this.#generation;
    this.#controller?.abort();
    const session = this.#session;
    const client = this.#client;
    this.#session = undefined;
    this.#terminal = true;
    this.#lastSequence = 0;
    this.resetFocus();
    shell.dataset.open = "false";
    await this.waitForCloseTransition();
    shell.hidden = true;
    this.element<HTMLElement>(".empty").hidden = false;
    this.element<HTMLElement>(".goal").hidden = false;
    const stage = this.element<HTMLElement>(".stage");
    stage.removeAttribute("data-viewer-ready");
    stage.setAttribute("aria-busy", "false");
    this.#root.querySelector("iframe")?.remove();
    this.setComposerEnabled(false);
    this.clearNotice();
    this.restorePage();
    if (session && client)
      await client.cancel(session, true).catch(() => {
        // The server expires abandoned sessions; closing the host UI must remain reliable.
      });
    if (generation === this.#generation) this.setStatus("Ready", "idle");
    this.emit("product-demo:close", undefined);
  }

  public async sendMessage(message?: string): Promise<void> {
    if (!this.#session || !this.#client || this.#terminal) {
      const error = new ProductDemoError("Start a demo before sending a message", {
        code: "configuration_error"
      });
      this.reportError(error, error.message);
      throw error;
    }
    const input = this.input(".composer input");
    const value = (message ?? input.value).trim();
    if (!value) {
      const error = new ProductDemoError("Message cannot be empty", {
        code: "configuration_error"
      });
      this.reportError(error, error.message);
      throw error;
    }
    try {
      this.setComposerEnabled(false);
      this.setStatus("Sending your update…", "loading");
      await this.#client.sendMessage(this.#session, value, this.#controller?.signal);
      if (message === undefined) input.value = "";
      if (!this.#terminal) this.setStatus("AI is demonstrating", "active");
    } catch (error) {
      this.reportError(error, "Could not send that update");
      throw error;
    } finally {
      if (this.#session && !this.#terminal) this.setComposerEnabled(true);
    }
  }

  private async startOnce(goal: string, turnstileToken?: string): Promise<{ sessionId: string }> {
    const normalizedGoal = goal.trim();
    if (normalizedGoal.length < 3 || normalizedGoal.length > 1_000) {
      const error = new ProductDemoError("Enter a goal between 3 and 1000 characters", {
        code: "configuration_error"
      });
      this.reportError(error, "Enter a valid demo goal");
      throw error;
    }
    const generation = ++this.#generation;
    const client = this.client();
    this.open();
    this.setStatus("Starting secure browser…", "loading");
    this.setLoadingCopy("Creating a secure browser session…");
    this.clearNotice();
    const startButton = this.button(".goal-submit");
    startButton.disabled = true;
    this.element<HTMLElement>(".goal-submit span").textContent = "Starting…";
    this.element<HTMLElement>(".stage").setAttribute("aria-busy", "true");
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
        throw new ProductDemoError("Demo start was superseded", { code: "aborted" });
      }
      this.#session = session;
      this.element<HTMLElement>(".goal").hidden = true;
      this.setComposerEnabled(true);
      this.emit("product-demo:start", { sessionId: session.sessionId });
      void this.consumeEvents(session, controller.signal, generation).catch((error: unknown) => {
        if (!controller.signal.aborted) this.reportError(error, "The live connection stopped");
      });
      return { sessionId: session.sessionId };
    } catch (error) {
      if (!controller.signal.aborted) {
        this.element<HTMLElement>(".stage").setAttribute("aria-busy", "false");
        this.reportError(error, "Could not start the demo");
        throw error;
      }
      throw new ProductDemoError("Demo start was aborted", { code: "aborted", cause: error });
    } finally {
      startButton.disabled = false;
      this.element<HTMLElement>(".goal-submit span").textContent = "Start live demo";
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
        this.setStatus("Reconnecting to the live demo…", "reconnecting");
        this.setLoadingCopy("The connection paused. Rejoining securely…");
        await delay(Math.min(10_000, 500 * 2 ** Math.min(attempt++, 5)), signal);
      }
    }
    if (!signal.aborted && !this.#terminal && Date.now() >= Date.parse(session.expiresAt)) {
      this.#terminal = true;
      this.resetFocus();
      this.setComposerEnabled(false);
      this.setStatus("Demo expired", "error");
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
    const labels: Record<string, { message: string; tone: StatusTone }> = {
      "session.starting": { message: "Starting secure browser…", tone: "loading" },
      "session.viewer_ready": { message: "Connecting live view…", tone: "loading" },
      "session.running": { message: "AI is demonstrating", tone: "active" },
      "session.completed": { message: "Demo complete", tone: "complete" },
      "session.failed": { message: "Demo stopped", tone: "error" },
      "session.cancelled": { message: "Demo cancelled", tone: "idle" },
      "session.expired": { message: "Demo expired", tone: "error" }
    };
    const label = labels[event.type];
    if (label) this.setStatus(label.message, label.tone);
    if (event.type === "session.starting")
      this.setLoadingCopy("Launching a clean demo environment…");
    if (event.type === "session.viewer_ready")
      this.setLoadingCopy("Connecting the secure live view…");
    if (event.type === "session.viewer_ready") void this.attachViewer(this.#generation);
    if (event.type === "agent.focus") this.applyFocus(event);
    if (event.type === "agent.action_started" && event.data.name !== "focus_element")
      this.resetFocus();
    if (event.type === "agent.narration")
      this.setStatus(
        typeof event.data.message === "string" ? event.data.message : "AI is demonstrating",
        "active"
      );
    if (
      ["session.completed", "session.failed", "session.cancelled", "session.expired"].includes(
        event.type
      )
    ) {
      this.#terminal = true;
      this.resetFocus();
      this.setComposerEnabled(false);
    }
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
      iframe.addEventListener(
        "load",
        () => {
          if (generation !== this.#generation || this.#session !== session) return;
          const stage = this.element<HTMLElement>(".stage");
          stage.dataset.viewerReady = "true";
          stage.setAttribute("aria-busy", "false");
          this.element<HTMLElement>(".empty").hidden = true;
          if (!this.#terminal) this.setStatus("AI is demonstrating", "active");
        },
        { once: true }
      );
      iframe.src = viewerUrl;
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
    this.setStatus(message, "error");
    const notice = this.element<HTMLElement>(".notice");
    notice.textContent = message;
    this.emit("product-demo:error", {
      message,
      ...(error instanceof ProductDemoError
        ? { code: error.code, status: error.status, requestId: error.requestId }
        : {})
    });
  }

  private setStatus(message: string, tone: StatusTone): void {
    this.dataset.status = tone;
    this.element<HTMLElement>(".status").textContent = message.slice(0, 500);
  }
  private setLoadingCopy(message: string): void {
    this.element<HTMLElement>(".loader-copy").textContent = message;
  }
  private setComposerEnabled(enabled: boolean): void {
    this.input(".composer input").disabled = !enabled;
    this.button(".send").disabled = !enabled;
  }
  private clearNotice(): void {
    this.element<HTMLElement>(".notice").textContent = "";
  }
  private applyFocus(event: DemoEvent): void {
    const focus = parseFocusEventData(event.data);
    const stage = this.element<HTMLElement>(".stage");
    stage.style.setProperty("--pd-focus-x", `${(focus.x * 100).toFixed(2)}%`);
    stage.style.setProperty("--pd-focus-y", `${(focus.y * 100).toFixed(2)}%`);
    stage.style.setProperty("--pd-focus-scale", focus.scale.toFixed(3));
    stage.dataset.focused = "true";
    this.dataset.focused = "true";
    if (this.#focusTimer) clearTimeout(this.#focusTimer);
    this.#focusTimer = setTimeout(() => this.resetFocus(), 4_200);
  }
  private resetFocus(): void {
    if (this.#focusTimer) clearTimeout(this.#focusTimer);
    this.#focusTimer = undefined;
    const stage = this.#root.querySelector<HTMLElement>(".stage");
    if (!stage) return;
    stage.removeAttribute("data-focused");
    delete this.dataset.focused;
    stage.style.removeProperty("--pd-focus-x");
    stage.style.removeProperty("--pd-focus-y");
    stage.style.removeProperty("--pd-focus-scale");
  }
  private async waitForCloseTransition(): Promise<void> {
    if (typeof matchMedia !== "function" || matchMedia("(prefers-reduced-motion: reduce)").matches)
      return;
    await new Promise<void>((resolve) => setTimeout(resolve, 220));
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

type StatusTone = "idle" | "loading" | "active" | "reconnecting" | "complete" | "error";

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

if (typeof customElements !== "undefined") {
  const registered = customElements.get("ai-product-demo");
  if (registered && registered !== ProductDemoElement)
    throw new Error("A different ai-product-demo custom element is already registered");
  if (!registered) customElements.define("ai-product-demo", ProductDemoElement);
}
