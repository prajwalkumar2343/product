import {
  TERMINAL_SESSION_STATUSES,
  type DemoSession,
  type Integration,
  type SessionEvent,
  type SessionEventType,
  type SessionStatus,
  type ToolCallRecord
} from "@product/contracts";
import type {
  AdmissionResult,
  RateLimitResult,
  SessionStore,
  SessionTransitionPatch
} from "./store.js";

export class MemoryStore implements SessionStore {
  public readonly integrations = new Map<string, Integration>();
  public readonly sessions = new Map<string, DemoSession>();
  public readonly events = new Map<string, SessionEvent[]>();
  public readonly calls = new Map<string, ToolCallRecord>();
  private readonly capacity = new Map<string, number>();
  private readonly rateLimits = new Map<string, { count: number; windowStartedAt: number }>();

  public async getIntegration(id: string) {
    return this.integrations.get(id) ?? null;
  }
  public async putIntegration(value: Integration) {
    this.integrations.set(value.id, value);
  }
  public async admitSession(value: DemoSession, maximum: number): Promise<AdmissionResult> {
    if (this.sessions.has(value.id)) return "exists";
    const active = this.capacity.get(value.integrationId) ?? 0;
    if (active >= maximum) return "capacity";
    this.sessions.set(value.id, value);
    this.capacity.set(value.integrationId, active + 1);
    await this.appendEvent(value.id, "session.accepted", {});
    return "admitted";
  }
  public async getSession(id: string) {
    return this.sessions.get(id) ?? null;
  }
  public async appendEvent(
    sessionId: string,
    type: SessionEventType,
    data: Record<string, unknown>
  ) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Session not found");
    const sequence = session.eventSequence + 1;
    const event = {
      schemaVersion: 1 as const,
      id: String(sequence),
      sessionId,
      sequence,
      type,
      data,
      createdAt: new Date().toISOString()
    } satisfies SessionEvent;
    this.sessions.set(sessionId, { ...session, eventSequence: sequence });
    this.events.set(sessionId, [...(this.events.get(sessionId) ?? []), event]);
    return event;
  }
  public async listEvents(sessionId: string, after: number, limit: number) {
    return (this.events.get(sessionId) ?? [])
      .filter((event) => event.sequence > after)
      .slice(0, limit);
  }
  public async transitionWithEvent(options: {
    sessionId: string;
    from: readonly SessionStatus[];
    to: SessionStatus;
    eventType: SessionEventType;
    eventData?: Record<string, unknown>;
    patch?: SessionTransitionPatch;
    leaseOwner?: string;
  }) {
    const current = this.sessions.get(options.sessionId);
    if (!current || !options.from.includes(current.status)) return null;
    if (options.leaseOwner && current.leaseOwner !== options.leaseOwner) return null;
    const updated = {
      ...current,
      ...options.patch,
      status: options.to,
      updatedAt: new Date().toISOString()
    };
    this.sessions.set(options.sessionId, updated);
    await this.appendEvent(options.sessionId, options.eventType, options.eventData ?? {});
    if (!TERMINAL_SESSION_STATUSES.has(current.status) && TERMINAL_SESSION_STATUSES.has(options.to))
      this.capacity.set(
        current.integrationId,
        Math.max(0, (this.capacity.get(current.integrationId) ?? 1) - 1)
      );
    return this.sessions.get(options.sessionId) ?? null;
  }
  public async claimLease(sessionId: string, owner: string, leaseExpiresAt: string) {
    const session = this.sessions.get(sessionId);
    if (!session || TERMINAL_SESSION_STATUSES.has(session.status)) return null;
    const now = new Date().toISOString();
    if (session.leaseExpiresAt && session.leaseExpiresAt > now && session.leaseOwner !== owner)
      return null;
    const updated = {
      ...session,
      leaseOwner: owner,
      leaseExpiresAt,
      lastHeartbeatAt: now,
      updatedAt: now
    };
    this.sessions.set(sessionId, updated);
    return updated;
  }
  public async heartbeat(sessionId: string, owner: string, leaseExpiresAt: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.leaseOwner !== owner || TERMINAL_SESSION_STATUSES.has(session.status))
      return false;
    const now = new Date().toISOString();
    this.sessions.set(sessionId, {
      ...session,
      leaseExpiresAt,
      lastHeartbeatAt: now,
      updatedAt: now
    });
    return true;
  }
  public async listExpiredSessions(now: string, limit: number) {
    return [...this.sessions.values()]
      .filter(
        (session) => !TERMINAL_SESSION_STATUSES.has(session.status) && session.expiresAt <= now
      )
      .slice(0, limit);
  }
  public async interruptRunningToolCalls(sessionId: string) {
    let count = 0;
    for (const [id, call] of this.calls)
      if (call.sessionId === sessionId && ["pending", "running"].includes(call.status)) {
        this.calls.set(id, { ...call, status: "interrupted" });
        count += 1;
      }
    return count;
  }
  public async startToolCall(call: ToolCallRecord, leaseOwner: string) {
    const session = this.sessions.get(call.sessionId);
    if (!session || session.status !== "running" || session.leaseOwner !== leaseOwner)
      throw new Error("Session is no longer authorized to execute tools");
    this.calls.set(call.id, { ...call, status: "running" });
    await this.appendEvent(call.sessionId, "agent.action_started", {
      callId: call.id,
      step: call.step,
      name: call.name
    });
  }
  public async settleToolCall(options: {
    sessionId: string;
    callId: string;
    status: "completed" | "failed" | "denied" | "interrupted";
    result?: Record<string, unknown>;
    error?: string;
    eventType: SessionEventType;
    eventData: Record<string, unknown>;
    leaseOwner: string;
  }) {
    const session = this.sessions.get(options.sessionId);
    if (!session || session.leaseOwner !== options.leaseOwner) return false;
    const call = this.calls.get(options.callId);
    if (!call) throw new Error("Tool call not found");
    if (call.sessionId !== options.sessionId) throw new Error("Tool call session mismatch");
    if (call.status !== "running") return false;
    this.calls.set(options.callId, {
      ...call,
      status: options.status,
      ...(options.result ? { result: options.result } : {}),
      ...(options.error ? { error: options.error } : {})
    });
    await this.appendEvent(options.sessionId, options.eventType, options.eventData);
    return true;
  }
  public async consumeRateLimit(options: {
    scope: string;
    key: string;
    limit: number;
    windowSeconds: number;
    now?: Date;
  }): Promise<RateLimitResult> {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1)
      throw new Error("Rate limit must be a positive integer");
    if (!Number.isSafeInteger(options.windowSeconds) || options.windowSeconds < 1)
      throw new Error("Rate limit window must be a positive integer");
    const now = (options.now ?? new Date()).getTime();
    const mapKey = `${options.scope}\0${options.key}`;
    const current = this.rateLimits.get(mapKey);
    const duration = options.windowSeconds * 1_000;
    const windowStartedAt =
      current && current.windowStartedAt <= now && now < current.windowStartedAt + duration
        ? current.windowStartedAt
        : now;
    const count = windowStartedAt === current?.windowStartedAt ? current.count : 0;
    const retryAfterSeconds = Math.max(1, Math.ceil((windowStartedAt + duration - now) / 1_000));
    if (count >= options.limit) return { allowed: false, remaining: 0, retryAfterSeconds };
    this.rateLimits.set(mapKey, { count: count + 1, windowStartedAt });
    return {
      allowed: true,
      remaining: Math.max(0, options.limit - count - 1),
      retryAfterSeconds
    };
  }
  public async healthCheck() {
    return;
  }
}
