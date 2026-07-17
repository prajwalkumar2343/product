export interface CreateResponse {
  sessionId: string;
  accessToken: string;
  expiresAt: string;
  eventsUrl: string;
  viewUrl: string;
}

export interface DemoEvent {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  sequence: number;
  type: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export function parseCreateSessionResponse(value: unknown): CreateResponse {
  const record = requireRecord(value, "create-session response");
  return {
    sessionId: requireString(record.sessionId, "sessionId", 200),
    accessToken: requireString(record.accessToken, "accessToken", 8_192),
    expiresAt: requireDateTime(record.expiresAt, "expiresAt"),
    eventsUrl: requireHttpUrl(record.eventsUrl, "eventsUrl"),
    viewUrl: requireHttpUrl(record.viewUrl, "viewUrl")
  };
}

export function parseSessionEvent(value: unknown): DemoEvent {
  const record = requireRecord(value, "session event");
  const data = requireRecord(record.data, "event.data");
  const sequence = record.sequence;
  if (!Number.isSafeInteger(sequence) || Number(sequence) < 0)
    throw new Error("Invalid event.sequence");
  if (record.schemaVersion !== 1) throw new Error("Unsupported event schema version");
  return {
    schemaVersion: 1,
    id: requireString(record.id, "event.id", 200),
    sessionId: requireString(record.sessionId, "event.sessionId", 200),
    sequence: Number(sequence),
    type: requireString(record.type, "event.type", 100),
    data,
    createdAt: requireDateTime(record.createdAt, "event.createdAt")
  };
}

export function parseViewResponse(value: unknown): { viewerUrl: string; expiresAt: string } {
  const record = requireRecord(value, "view response");
  const viewerUrl = requireHttpUrl(record.viewerUrl, "viewerUrl");
  const url = new URL(viewerUrl);
  if (
    url.protocol !== "https:" ||
    (url.hostname !== "steel.dev" && !url.hostname.endsWith(".steel.dev"))
  ) {
    throw new Error("Untrusted viewer URL");
  }
  return { viewerUrl, expiresAt: requireDateTime(record.expiresAt, "expiresAt") };
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid ${field}`);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string, maximum = 4_096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum)
    throw new Error(`Invalid ${field}`);
  return value;
}

function requireDateTime(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(text) || !Number.isFinite(Date.parse(text)))
    throw new Error(`Invalid ${field}`);
  return text;
}

function requireHttpUrl(value: unknown, field: string): string {
  const text = requireString(value, field);
  const url = new URL(text);
  if (url.username || url.password) throw new Error(`Invalid ${field}`);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))
  ) {
    throw new Error(`Invalid ${field}`);
  }
  return url.href;
}
