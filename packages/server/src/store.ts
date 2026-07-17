import {
  DemoSessionSchema,
  IntegrationSchema,
  SessionEventSchema,
  TERMINAL_SESSION_STATUSES,
  ToolCallRecordSchema,
  type DemoSession,
  type Integration,
  type SessionEvent,
  type SessionEventType,
  type SessionStatus,
  type ToolCallRecord
} from "@product/contracts";
import { Firestore, type DocumentReference } from "@google-cloud/firestore";
import { createHash } from "node:crypto";

export type AdmissionResult = "admitted" | "exists" | "capacity";
export type SessionTransitionPatch = Partial<
  Pick<
    DemoSession,
    "steelSessionId" | "viewerUrl" | "completedAt" | "failureCode" | "failureMessage"
  >
>;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export interface SessionStore {
  getIntegration(id: string): Promise<Integration | null>;
  putIntegration(integration: Integration): Promise<void>;
  admitSession(session: DemoSession, maxConcurrentSessions: number): Promise<AdmissionResult>;
  getSession(id: string): Promise<DemoSession | null>;
  appendEvent(
    sessionId: string,
    type: SessionEventType,
    data: Record<string, unknown>
  ): Promise<SessionEvent>;
  listEvents(sessionId: string, after: number, limit: number): Promise<SessionEvent[]>;
  transitionWithEvent(options: {
    sessionId: string;
    from: readonly SessionStatus[];
    to: SessionStatus;
    eventType: SessionEventType;
    eventData?: Record<string, unknown>;
    patch?: SessionTransitionPatch;
    leaseOwner?: string;
  }): Promise<DemoSession | null>;
  claimLease(sessionId: string, owner: string, leaseUntil: string): Promise<DemoSession | null>;
  heartbeat(sessionId: string, owner: string, leaseUntil: string): Promise<boolean>;
  listExpiredSessions(now: string, limit: number): Promise<DemoSession[]>;
  interruptRunningToolCalls(sessionId: string): Promise<number>;
  startToolCall(call: ToolCallRecord, leaseOwner: string): Promise<void>;
  settleToolCall(options: {
    sessionId: string;
    callId: string;
    status: "completed" | "failed" | "denied" | "interrupted";
    result?: Record<string, unknown>;
    error?: string;
    eventType: SessionEventType;
    eventData: Record<string, unknown>;
    leaseOwner: string;
  }): Promise<boolean>;
  consumeRateLimit(options: {
    scope: string;
    key: string;
    limit: number;
    windowSeconds: number;
    now?: Date;
  }): Promise<RateLimitResult>;
  healthCheck(): Promise<void>;
}

export class FirestoreSessionStore implements SessionStore {
  private readonly db: Firestore;

  public constructor(projectId: string, databaseId: string) {
    this.db = new Firestore({ projectId, databaseId });
  }

  public async getIntegration(id: string): Promise<Integration | null> {
    const snapshot = await this.db.collection("integrations").doc(id).get();
    return snapshot.exists ? IntegrationSchema.parse(snapshot.data()) : null;
  }

  public async putIntegration(integration: Integration): Promise<void> {
    await this.db
      .collection("integrations")
      .doc(integration.id)
      .set(IntegrationSchema.parse(integration));
  }

  public async admitSession(
    session: DemoSession,
    maxConcurrentSessions: number
  ): Promise<AdmissionResult> {
    const sessionRef = this.sessionRef(session.id);
    const capacityRef = this.db.collection("integrationCapacity").doc(session.integrationId);
    return this.db.runTransaction(async (transaction) => {
      const existing = await transaction.get(sessionRef);
      const capacity = await transaction.get(capacityRef);
      if (existing.exists) return "exists";
      const active = Number(capacity.data()?.active ?? 0);
      if (!Number.isSafeInteger(active) || active < 0) throw new Error("Invalid capacity record");
      if (active >= maxConcurrentSessions) return "capacity";
      const admitted = DemoSessionSchema.parse(session);
      const event = buildEvent(admitted, "session.accepted", {}, 1);
      transaction.create(sessionRef, { ...admitted, eventSequence: 1 });
      transaction.create(sessionRef.collection("events").doc(event.id), event);
      transaction.set(capacityRef, { active: active + 1, updatedAt: event.createdAt });
      return "admitted";
    });
  }

  public async getSession(id: string): Promise<DemoSession | null> {
    const snapshot = await this.sessionRef(id).get();
    return snapshot.exists ? DemoSessionSchema.parse(snapshot.data()) : null;
  }

  public async appendEvent(
    sessionId: string,
    type: SessionEventType,
    data: Record<string, unknown>
  ): Promise<SessionEvent> {
    return this.db.runTransaction(async (transaction) => {
      const ref = this.sessionRef(sessionId);
      const session = parseSessionSnapshot(await transaction.get(ref));
      const event = buildEvent(session, type, data, session.eventSequence + 1);
      transaction.update(ref, { eventSequence: event.sequence, updatedAt: event.createdAt });
      transaction.create(ref.collection("events").doc(event.id), event);
      return event;
    });
  }

  public async listEvents(
    sessionId: string,
    after: number,
    limit: number
  ): Promise<SessionEvent[]> {
    const boundedLimit = Math.min(200, Math.max(1, limit));
    const snapshot = await this.sessionRef(sessionId)
      .collection("events")
      .where("sequence", ">", after)
      .orderBy("sequence")
      .limit(boundedLimit)
      .get();
    return snapshot.docs.map((document) => SessionEventSchema.parse(document.data()));
  }

  public async transitionWithEvent(options: {
    sessionId: string;
    from: readonly SessionStatus[];
    to: SessionStatus;
    eventType: SessionEventType;
    eventData?: Record<string, unknown>;
    patch?: SessionTransitionPatch;
    leaseOwner?: string;
  }): Promise<DemoSession | null> {
    const sessionRef = this.sessionRef(options.sessionId);
    const now = new Date().toISOString();
    return this.db.runTransaction(async (transaction) => {
      const session = parseSessionSnapshot(await transaction.get(sessionRef));
      if (!options.from.includes(session.status)) return null;
      if (options.leaseOwner && session.leaseOwner !== options.leaseOwner) return null;
      const becomingTerminal =
        !TERMINAL_SESSION_STATUSES.has(session.status) && TERMINAL_SESSION_STATUSES.has(options.to);
      const capacityRef = this.db.collection("integrationCapacity").doc(session.integrationId);
      const capacity = becomingTerminal ? await transaction.get(capacityRef) : null;
      const event = buildEvent(
        session,
        options.eventType,
        options.eventData ?? {},
        session.eventSequence + 1,
        now
      );
      const updated = DemoSessionSchema.parse({
        ...session,
        ...options.patch,
        status: options.to,
        eventSequence: event.sequence,
        updatedAt: now
      });
      transaction.set(sessionRef, updated);
      transaction.create(sessionRef.collection("events").doc(event.id), event);
      if (capacity) {
        const active = Number(capacity.data()?.active ?? 0);
        if (!Number.isSafeInteger(active) || active <= 0)
          throw new Error("Capacity counter underflow");
        transaction.set(capacityRef, { active: active - 1, updatedAt: now });
      }
      return updated;
    });
  }

  public async claimLease(
    sessionId: string,
    owner: string,
    leaseUntil: string
  ): Promise<DemoSession | null> {
    const ref = this.sessionRef(sessionId);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) return null;
      const current = DemoSessionSchema.parse(snapshot.data());
      if (TERMINAL_SESSION_STATUSES.has(current.status)) return null;
      const now = new Date().toISOString();
      if (current.leaseExpiresAt && current.leaseExpiresAt > now && current.leaseOwner !== owner)
        return null;
      const updated = DemoSessionSchema.parse({
        ...current,
        leaseOwner: owner,
        leaseExpiresAt: leaseUntil,
        lastHeartbeatAt: now,
        updatedAt: now
      });
      transaction.set(ref, updated);
      return updated;
    });
  }

  public async heartbeat(sessionId: string, owner: string, leaseUntil: string): Promise<boolean> {
    const ref = this.sessionRef(sessionId);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) return false;
      const session = DemoSessionSchema.parse(snapshot.data());
      if (session.leaseOwner !== owner || TERMINAL_SESSION_STATUSES.has(session.status))
        return false;
      const now = new Date().toISOString();
      transaction.update(ref, { leaseExpiresAt: leaseUntil, lastHeartbeatAt: now, updatedAt: now });
      return true;
    });
  }

  public async interruptRunningToolCalls(sessionId: string): Promise<number> {
    const snapshot = await this.sessionRef(sessionId)
      .collection("toolCalls")
      .where("status", "in", ["pending", "running"])
      .get();
    if (snapshot.empty) return 0;
    const batch = this.db.batch();
    const now = new Date().toISOString();
    for (const document of snapshot.docs)
      batch.update(document.ref, {
        status: "interrupted",
        error: "Worker restarted before completion",
        updatedAt: now
      });
    await batch.commit();
    return snapshot.size;
  }

  public async listExpiredSessions(now: string, limit: number): Promise<DemoSession[]> {
    const snapshot = await this.db
      .collection("sessions")
      .where("status", "in", [
        "accepted",
        "queued",
        "starting",
        "browser_ready",
        "running",
        "completing"
      ])
      .where("expiresAt", "<=", now)
      .limit(Math.min(100, Math.max(1, limit)))
      .get();
    return snapshot.docs.map((document) => DemoSessionSchema.parse(document.data()));
  }

  public async startToolCall(call: ToolCallRecord, leaseOwner: string): Promise<void> {
    const running = ToolCallRecordSchema.parse({ ...call, status: "running" });
    const sessionRef = this.sessionRef(call.sessionId);
    await this.db.runTransaction(async (transaction) => {
      const session = parseSessionSnapshot(await transaction.get(sessionRef));
      if (session.status !== "running" || session.leaseOwner !== leaseOwner) {
        throw new Error("Session is no longer authorized to execute tools");
      }
      const event = buildEvent(
        session,
        "agent.action_started",
        { step: call.step, name: call.name, callId: call.id },
        session.eventSequence + 1
      );
      transaction.create(sessionRef.collection("toolCalls").doc(call.id), running);
      transaction.update(sessionRef, { eventSequence: event.sequence, updatedAt: event.createdAt });
      transaction.create(sessionRef.collection("events").doc(event.id), event);
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
  }): Promise<boolean> {
    const sessionRef = this.sessionRef(options.sessionId);
    return this.db.runTransaction(async (transaction) => {
      const session = parseSessionSnapshot(await transaction.get(sessionRef));
      if (session.leaseOwner !== options.leaseOwner) return false;
      const callRef = sessionRef.collection("toolCalls").doc(options.callId);
      const callSnapshot = await transaction.get(callRef);
      if (!callSnapshot.exists) throw new Error("Tool call not found");
      const call = ToolCallRecordSchema.parse(callSnapshot.data());
      if (call.sessionId !== options.sessionId) throw new Error("Tool call session mismatch");
      if (call.status !== "running") return false;
      const event = buildEvent(
        session,
        options.eventType,
        options.eventData,
        session.eventSequence + 1
      );
      transaction.update(callRef, {
        status: options.status,
        ...(options.result ? { result: options.result } : {}),
        ...(options.error ? { error: options.error } : {}),
        updatedAt: event.createdAt
      });
      transaction.update(sessionRef, { eventSequence: event.sequence, updatedAt: event.createdAt });
      transaction.create(sessionRef.collection("events").doc(event.id), event);
      return true;
    });
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
    const now = options.now ?? new Date();
    const nowMs = now.getTime();
    const durationMs = options.windowSeconds * 1_000;
    const id = createHash("sha256").update(`${options.scope}\0${options.key}`).digest("hex");
    const ref = this.db.collection("rateLimits").doc(id);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const data = snapshot.data();
      const storedStartedAt = typeof data?.windowStartedAt === "string" ? data.windowStartedAt : "";
      const parsedStartedAt = Date.parse(storedStartedAt);
      const storedCount = Number(data?.count ?? 0);
      const validWindow =
        Number.isFinite(parsedStartedAt) &&
        parsedStartedAt <= nowMs &&
        nowMs < parsedStartedAt + durationMs &&
        Number.isSafeInteger(storedCount) &&
        storedCount >= 0;
      const windowStartedAtMs = validWindow ? parsedStartedAt : nowMs;
      const count = validWindow ? storedCount : 0;
      const resetAtMs = windowStartedAtMs + durationMs;
      const retryAfterSeconds = Math.max(1, Math.ceil((resetAtMs - nowMs) / 1_000));
      if (count >= options.limit) return { allowed: false, remaining: 0, retryAfterSeconds };
      const nextCount = count + 1;
      transaction.set(ref, {
        scope: options.scope,
        count: nextCount,
        windowStartedAt: new Date(windowStartedAtMs).toISOString(),
        expiresAt: new Date(resetAtMs + durationMs).toISOString()
      });
      return {
        allowed: true,
        remaining: Math.max(0, options.limit - nextCount),
        retryAfterSeconds
      };
    });
  }

  public async healthCheck(): Promise<void> {
    await this.db.collection("integrations").limit(1).get();
  }

  private sessionRef(id: string): DocumentReference {
    return this.db.collection("sessions").doc(id);
  }
}

function parseSessionSnapshot(snapshot: FirebaseFirestore.DocumentSnapshot): DemoSession {
  if (!snapshot.exists) throw new Error("Session not found");
  return DemoSessionSchema.parse(snapshot.data());
}

function buildEvent(
  session: DemoSession,
  type: SessionEventType,
  data: Record<string, unknown>,
  sequence: number,
  createdAt = new Date().toISOString()
): SessionEvent {
  return SessionEventSchema.parse({
    schemaVersion: 1,
    id: String(sequence).padStart(10, "0"),
    sessionId: session.id,
    sequence,
    type,
    data,
    createdAt
  });
}
