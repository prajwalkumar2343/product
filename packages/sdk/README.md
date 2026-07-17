# Product Demo browser SDK

Add a secure, live AI product demo to an existing button without exposing server credentials or
rebuilding the host website.

## Existing button

```html
<script
  src="https://cdn.example.com/product-demo/v0.1.0/product-demo.js"
  integrity="sha384-REPLACE_WITH_RELEASE_VALUE"
  crossorigin="anonymous"
  defer
></script>

<button id="see-demo">See the product in action</button>

<script>
  window.addEventListener("DOMContentLoaded", () => {
    const demo = ProductDemo.mount({
      trigger: "#see-demo",
      integrationId: "acme",
      apiUrl: "https://demo-api.example.com",
      getChallengeToken: () => turnstile.execute("public-widget-id", { action: "product_demo" })
    });

    demo.on("product-demo:error", ({ detail }) => {
      console.warn("Demo error", detail.code, detail.requestId);
    });
  });
</script>
```

`ProductDemo.mount` creates the modal, keeps the customer button's design, and returns a controller:

```js
demo.open();
await demo.start("Show me how analytics filters work");
await demo.sendMessage("Now compare this month with last month");
await demo.close();
await demo.destroy();
```

## Package / ESM

```bash
npm install @product/embed
```

```ts
import { mount, ProductDemoApiError } from "@product/embed";

const demo = mount({
  trigger: document.querySelector("#see-demo"),
  integrationId: "acme",
  apiUrl: "https://demo-api.example.com"
});

demo.on("product-demo:error", (event) => {
  const { code, status, requestId } = (event as CustomEvent).detail;
  console.error({ code, status, requestId });
});
```

The ESM entry is safe to import during server rendering. Call `mount` only in the browser.

## Declarative component

```html
<ai-product-demo integration-id="acme" api-url="https://demo-api.example.com">
  See a live AI demo
</ai-product-demo>
```

```js
const demo = document.querySelector("ai-product-demo");
demo.locale = "en-IN";
demo.getChallengeToken = () => turnstile.execute("public-widget-id", { action: "product_demo" });
```

## Typed low-level client

Use the client directly when a team needs to build its own UI:

```ts
import { ProductDemoClient } from "@product/embed/client";

const client = new ProductDemoClient({
  apiUrl: "https://demo-api.example.com",
  integrationId: "acme",
  timeoutMilliseconds: 15_000,
  maxRetries: 2
});

const session = await client.create({
  goal: "Show analytics",
  locale: "en"
});
```

Like Steel's official SDK, the client accepts a custom `fetch` implementation for tracing or test
isolation. Session creation is retried only with the same idempotency key. Errors are
`ProductDemoError` instances with a stable `code`; HTTP failures are `ProductDemoApiError` instances
that also expose `status`, `retryAfterSeconds`, and `requestId`.

## Security and CSP

- Browser code receives only a short-lived session capability. Keep all private keys server-side.
- The client pins session endpoints to the configured API origin and never sends browser cookies.
- Publish immutable SDK URLs with SRI and `crossorigin="anonymous"`.
- Add the SDK CDN to `script-src`, the API origin to `connect-src`, and Steel's viewer origin to
  `frame-src`.
- Register every production website origin in the integration allowlist. Wildcard CORS is not used.

The viewer iframe is sandboxed and receives no clipboard permission. Stream buffers, response bodies,
retry counts, and reconnect delays are bounded.
