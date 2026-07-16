# Security model

## Required deployment assumptions

- Every integration targets a dedicated demo tenant with synthetic, resettable data.
- Demo accounts cannot access production customer data, billing, email, invitations, exports, secrets, or administrative functions.
- Allowed hosts include every required first-party/API/static hostname and nothing else.
- Fixture values are non-secret examples. Credentials belong in Steel profiles or a controlled demo login flow, never in fixture JSON or prompts.

## Controls

The browser API uses exact origin matching—no wildcard or suffix matching. Browsers must send `Origin`; session routes additionally require a short-lived bearer capability bound to the session and original origin. Tokens are never accepted in URLs or cookies, preventing referrer and ambient-authority leakage.

Creation requires a 16–200 character idempotency key, per-IP/origin rate limiting, an optional Turnstile challenge, and an integration concurrency limit. Request bodies are small and schema validated. API responses use no-store, nosniff, and no-referrer headers.

The runner has private ingress, Cloud Run IAM, a dedicated task identity, least-privilege service accounts, and Secret Manager references. It accepts only a validated session ID. The model cannot call the runner or Steel directly.

Navigation is allowed only to exact configured hostnames over HTTPS. All document, fetch/XHR, script, stylesheet, image, font, and media requests are intercepted. The agent cannot supply a URL; it selects a reviewed feature ID mapped to a configured relative path.

Clicks use ephemeral references returned by the latest page inspection and are denied unless the element declares a `data-ai-demo-action` capability present in the integration's `allowedActionIds`. Inputs must declare a matching `data-ai-demo-input` fixture key. Forbidden label patterns remain defense in depth, not the primary authorization mechanism. Tool output and prompt inputs are length bounded.

The branded cursor is inert presentation, not a new control channel. Its host is accessibility-hidden, cannot receive pointer events or focus, contains no session data, and is isolated with a closed Shadow DOM. It follows only browser actions that have already passed the existing capability policy. Steel's viewer remains non-interactive, and its native system cursor is disabled to prevent an ambiguous second pointer.

## Known boundary and hardening before public traffic

UI text matching is defense in depth, not a substitute for tenant isolation. Before onboarding a product, test every configured feature and remove destructive permissions at the demo account/backend layer. Configure the demo application's CSP `frame-ancestors` so it can render in Steel as needed, and verify Steel's viewer is permitted by the customer's CSP.

Rotate HMAC, Steel, model, and Turnstile secrets on suspected exposure. Rotating the HMAC key invalidates all active session capabilities. Do not log request authorization headers, viewer URLs, model prompts containing user content, or Firestore session documents wholesale.

## Threats explicitly out of scope

This first release does not provide human takeover, customer-supplied credentials, file uploads/downloads, arbitrary browsing, transactions, multi-region failover, or demoing native desktop applications.
