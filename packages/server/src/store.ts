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

export type AdmissionResult = "admitted" | "exists" | "capacity";

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
    patch?: Partial<DemoSession>;
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
  }): Promise<void>;
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
    patch?: Partial<DemoSession>;
  }): Promise<DemoSession | null> {
    const sessionRef = this.sessionRef(options.sessionId);
    const now = new Date().toISOString();
    return this.db.runTransaction(async (transaction) => {
      const session = parseSessionSnapshot(await transaction.get(sessionRef));
      if (!options.from.includes(session.status)) return null;
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
  }): Promise<void> {
    const sessionRef = this.sessionRef(options.sessionId);
    await this.db.runTransaction(async (transaction) => {
      const session = parseSessionSnapshot(await transaction.get(sessionRef));
      const event = buildEvent(
        session,
        options.eventType,
        options.eventData,
        session.eventSequence + 1
      );
      transaction.update(sessionRef.collection("toolCalls").doc(options.callId), {
        status: options.status,
        ...(options.result ? { result: options.result } : {}),
        ...(options.error ? { error: options.error } : {}),
        updatedAt: event.createdAt
      });
      transaction.update(sessionRef, { eventSequence: event.sequence, updatedAt: event.createdAt });
      transaction.create(sessionRef.collection("events").doc(event.id), event);
    });
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
