# ProductDemo JavaScript SDK

Add a live AI product demo to an existing button with one client and one method.

## Install

```bash
npm install @product/sdk
```

## Quickstart

```ts
import ProductDemo from "@product/sdk";

const demo = new ProductDemo({
  integrationId: "int_acme"
});

demo.mount("#see-demo");
```

```html
<button id="see-demo">See a live demo</button>
```

`mount()` keeps the website's existing button and design. Clicking it opens the live demo on the
same page.

## CDN

```html
<script
  src="https://cdn.example.com/product-demo/v1.0.0/product-demo.js"
  integrity="sha384-REPLACE_WITH_RELEASE_VALUE"
  crossorigin="anonymous"
  defer
></script>

<button id="see-demo">See a live demo</button>

<script>
  window.addEventListener("DOMContentLoaded", () => {
    const demo = new ProductDemo({
      integrationId: "int_acme"
    });

    demo.mount("#see-demo");
  });
</script>
```

The CDN script exposes the constructor directly as `window.ProductDemo`.

## Optional controls

Most websites only need `mount()`. Applications that need more control can use:

```ts
demo.open();

const { sessionId } = await demo.start("Show me how analytics filters work");

await demo.send("Now compare this month with last month");
await demo.close();
await demo.destroy();
```

`start()` resolves when the server accepts the session; the live demo continues in the modal.
`destroy()` is idempotent and removes the modal and trigger listener.

## Events

```ts
const stopListening = demo.on("started", ({ sessionId }) => {
  console.log("Demo started", sessionId);
});

demo.on("error", ({ code, status, requestId, message }) => {
  console.error({ code, status, requestId, message });
});

demo.on("closed", () => {
  console.log("Demo closed");
});

stopListening();
```

Supported events are `open`, `started`, `event`, `error`, and `closed`.

## Turnstile

If the integration requires Cloudflare Turnstile, provide a callback that returns a short-lived
public challenge token:

```ts
const demo = new ProductDemo({
  integrationId: "int_acme",
  getChallengeToken: () =>
    turnstile.execute("public-widget-id", {
      action: "product_demo"
    })
});
```

Never put a Turnstile secret, Steel API key, model key, or session-signing secret in browser code.

## Self-hosting and advanced transport

The hosted SDK already contains the production API endpoint. Self-hosted deployments may override
it:

```ts
const demo = new ProductDemo({
  integrationId: "int_acme",
  baseURL: "https://demo-api.example.com",
  timeout: 15_000,
  maxRetries: 2,
  fetch: customFetch
});
```

The SDK validates the API origin, omits browser cookies, rejects redirects, uses stable idempotency
keys for safe retries, and exposes typed errors as `ProductDemo.Error` and
`ProductDemo.APIError`.

## Content Security Policy

For a strict CSP, allow:

- the immutable SDK URL in `script-src`;
- the product-demo API origin in `connect-src`;
- Steel's viewer origin in `frame-src`.

Publish CDN builds with Subresource Integrity and `crossorigin="anonymous"`.
