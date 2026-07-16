# Operations runbook

## Alerts

Create alerts for API 5xx rate, task retry/exhaustion count, task age, runner 5xx/timeouts, session failure ratio, session startup p95, active sessions near the queue/instance cap, Firestore errors, and Steel/model provider error rates. Alert on cost-budget thresholds separately.

Never attach authorization headers, viewer URLs, full prompts, or fixture values to logs/telemetry. Correlate by `traceId` and `sessionId`.

## Common incidents

**Queue age rising:** check runner max instances, Cloud Run quota, task IAM, Steel capacity, and model latency. Increase a reviewed cap only after confirming provider and budget headroom.

**Viewer never becomes ready:** inspect `session.starting`, Steel creation errors, and runner task logs. A failed session should have a stable `failureCode`; do not expose provider error details to visitors.

**Agent blocked repeatedly:** review integration allowed hosts, feature paths, fixture keys, and forbidden patterns. Never weaken global policy based only on a model request.

**Orphan Steel sessions:** the minute scheduler marks sessions past `expiresAt` as expired and releases their Steel session; Steel's own timeout is the independent crash backstop. Alert when sweeps fail or expired active records remain. During an incident, reconcile Steel's active-session list against Firestore and do not delete the audit trail.

**Suspected token/secret leak:** rotate the relevant Secret Manager version. For capability/HMAC exposure, rotate `session-hmac-secret` and deploy both API and runner together, accepting that active demos will terminate. Revoke Steel/model keys at their providers.

## Recovery and rollback

Cloud Run retains immutable revisions. Roll traffic back to the last canary-tested revision. Do not roll back Firestore schema assumptions without verifying compatibility. Task delivery is at least once, so a rollback must preserve lease and idempotency behavior.

Firestore point-in-time recovery/export and Terraform remote state must be enabled and tested by the operator. Quarterly, restore into a separate project and verify integration/session/event readability.
