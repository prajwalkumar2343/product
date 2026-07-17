import { ProductDemoClient } from "./client.js";
import { ProductDemoElement } from "./element.js";
import { ProductDemoApiError, ProductDemoError } from "./errors.js";
import type { DemoEvent } from "./protocol.js";

declare const __PRODUCT_DEMO_API_URL__: string;

export interface ProductDemoOptions {
  /** Public integration identifier from the product-demo configuration. */
  integrationId: string;
  /** Locale sent with new demo sessions. Defaults to the browser locale. */
  locale?: string;
  /** Returns a short-lived public anti-abuse challenge token when required. */
  getChallengeToken?: () => Promise<string | undefined>;
  /** Advanced: overrides the hosted API for self-hosted deployments. */
  baseURL?: string;
  /** Advanced: custom Fetch API implementation for tracing and tests. */
  fetch?: typeof globalThis.fetch;
  /** Advanced: timeout for individual API requests. */
  timeout?: number;
  /** Advanced: retry count for idempotent session creation. */
  maxRetries?: number;
}

export interface ProductDemoStartOptions {
  turnstileToken?: string;
}

export interface ProductDemoErrorEvent {
  message: string;
  code?: string;
  status?: number;
  requestId?: string;
}

export interface ProductDemoEvents {
  open: undefined;
  started: { sessionId: string };
  event: DemoEvent;
  error: ProductDemoErrorEvent;
  closed: undefined;
}

const internalEventNames: Record<keyof ProductDemoEvents, string> = {
  open: "product-demo:open",
  started: "product-demo:start",
  event: "product-demo:event",
  error: "product-demo:error",
  closed: "product-demo:close"
};

export default class ProductDemo {
  public static readonly Error = ProductDemoError;
  public static readonly APIError = ProductDemoApiError;

  readonly #options: ProductDemoOptions;
  readonly #client: ProductDemoClient;
  #element: ProductDemoElement | undefined;
  #trigger: HTMLElement | undefined;
  #openFromTrigger: ((event: Event) => void) | undefined;

  public constructor(options: ProductDemoOptions) {
    const baseURL = options.baseURL ?? resolveHostedApiUrl();
    this.#client = new ProductDemoClient({
      apiUrl: baseURL,
      integrationId: options.integrationId,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.timeout !== undefined ? { timeoutMilliseconds: options.timeout } : {}),
      ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {})
    });
    this.#options = { ...options, baseURL };
  }

  /** Attach the demo modal to an existing button or link. */
  public mount(trigger: string | HTMLElement): this {
    const resolved = resolveTrigger(trigger);
    if (this.#trigger) {
      if (this.#trigger === resolved) return this;
      throw new ProductDemoError("This ProductDemo instance is already mounted", {
        code: "configuration_error"
      });
    }
    const element = this.ensureElement();
    const open = (event: Event) => {
      if (resolved instanceof HTMLAnchorElement) event.preventDefault();
      element.open();
    };
    resolved.addEventListener("click", open);
    this.#trigger = resolved;
    this.#openFromTrigger = open;
    return this;
  }

  public open(): void {
    this.ensureElement().open();
  }

  public start(
    goal: string,
    options: ProductDemoStartOptions = {}
  ): Promise<{ sessionId: string }> {
    return this.ensureElement().start(goal, options.turnstileToken);
  }

  public send(message: string): Promise<void> {
    return this.ensureElement().sendMessage(message);
  }

  public close(): Promise<void> {
    return this.#element?.close() ?? Promise.resolve();
  }

  public on<EventName extends keyof ProductDemoEvents>(
    name: EventName,
    listener: (event: ProductDemoEvents[EventName]) => void
  ): () => void {
    const element = this.ensureElement();
    const wrapped = (event: Event) =>
      listener((event as CustomEvent<ProductDemoEvents[EventName]>).detail);
    element.addEventListener(internalEventNames[name], wrapped);
    return () => element.removeEventListener(internalEventNames[name], wrapped);
  }

  /** Release listeners, cancel an active session, and remove the modal. Safe to call repeatedly. */
  public async destroy(): Promise<void> {
    if (this.#trigger && this.#openFromTrigger)
      this.#trigger.removeEventListener("click", this.#openFromTrigger);
    this.#trigger = undefined;
    this.#openFromTrigger = undefined;
    const element = this.#element;
    this.#element = undefined;
    if (!element) return;
    await element.close();
    element.remove();
  }

  private ensureElement(): ProductDemoElement {
    if (this.#element) return this.#element;
    if (typeof document === "undefined")
      throw new ProductDemoError("ProductDemo can only be used in a browser", {
        code: "configuration_error"
      });
    const element = new ProductDemoElement();
    element.setAttribute("external-trigger", "");
    const locale =
      this.#options.locale ?? (typeof navigator === "undefined" ? undefined : navigator.language);
    element.configure({
      client: this.#client,
      integrationId: this.#options.integrationId,
      ...(locale ? { locale } : {}),
      ...(this.#options.getChallengeToken
        ? { getChallengeToken: this.#options.getChallengeToken }
        : {})
    });
    document.body.append(element);
    this.#element = element;
    return element;
  }
}

function resolveHostedApiUrl(): string {
  if (typeof __PRODUCT_DEMO_API_URL__ === "string" && __PRODUCT_DEMO_API_URL__.length > 0)
    return __PRODUCT_DEMO_API_URL__;
  throw new ProductDemoError(
    "This SDK build has no hosted API configured; provide baseURL for a self-hosted deployment",
    { code: "configuration_error" }
  );
}

function resolveTrigger(trigger: string | HTMLElement): HTMLElement {
  if (typeof document === "undefined")
    throw new ProductDemoError("ProductDemo.mount can only be used in a browser", {
      code: "configuration_error"
    });
  const resolved =
    typeof trigger === "string" ? document.querySelector<HTMLElement>(trigger) : trigger;
  if (!resolved)
    throw new ProductDemoError("The demo trigger was not found", {
      code: "configuration_error"
    });
  if (
    !(resolved instanceof HTMLButtonElement) &&
    !(resolved instanceof HTMLAnchorElement) &&
    resolved.getAttribute("role") !== "button"
  )
    throw new ProductDemoError("The demo trigger must be a button or link", {
      code: "configuration_error"
    });
  return resolved;
}
