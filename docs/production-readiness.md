# Production readiness contract

“Production-grade” is an operational claim, not a synonym for compiled code. This repository supplies the controls below; a release is not approved until the environment-specific gates also pass.

## Enforced in code and CI

- Atomic admission/capacity and atomic state/event persistence.
- Idempotent task names with ambiguous-create reconciliation and bounded retries.
- Exclusive leases, interrupted-tool reconciliation, cancellation, deadlines, Steel release, and scheduled expiration.
- Versioned persisted schemas with validation on reads.
- Exact-origin capabilities, Turnstile host/action binding, private runner IAM, and sanitized API errors.
- Exact network host policy, service-worker bypass, WebSocket policy, and default-deny element capabilities.
- Bounded model context/output, typed tools, provider timeouts/retries, and token/latency evidence events.
- Runtime-validated embed protocol, terminal stream handling, sandboxed Steel iframe, and a sub-10 KB minified SDK target.
- Pinned runtime dependencies, immutable GitHub Action SHAs, dependency audit, Docker build, Terraform formatting/validation, and protected manual production deployment.

## Mandatory environment gates

1. Run a real Steel/model canary in staging for every supported demo workflow. No paid-provider call is made by unit tests.
2. Verify the customer site's CSP and Steel viewer embedding in Chrome, Safari, Firefox, mobile widths, and assistive technology.
3. Run concurrency/load tests at the intended launch rate and prove API p95, queue age, runner startup p95, Firestore contention, and cost per successful demo against explicit SLOs.
4. Exercise cancellation during model calls and browser actions, task redelivery, runner termination, Steel outage, model 429/5xx, Firestore outage, and scheduler failure.
5. Complete threat modeling and penetration testing for origin/token theft, prompt injection, UI capability bypass, SSRF, viewer URL exposure, and demo-tenant privilege escalation.
6. Verify alerts, budget limits, secret rotation, rollback, Firestore recovery, and the incident on-call path.

Until these gates pass in the actual cloud account with real product integrations, the repository is a production candidate—not a deployed production system.
