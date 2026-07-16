import Steel from "steel-sdk";

export interface BrowserSession {
  id: string;
  websocketUrl: string;
  viewerUrl: string;
}

export interface BrowserProvider {
  create(options: { timeoutMilliseconds: number; profileId?: string }): Promise<BrowserSession>;
  release(sessionId: string): Promise<void>;
}

export class SteelBrowserProvider implements BrowserProvider {
  private readonly client: Pick<Steel, "sessions">;

  public constructor(options: { apiKey: string; client?: Pick<Steel, "sessions"> }) {
    this.client =
      options.client ?? new Steel({ steelAPIKey: options.apiKey, timeout: 30_000, maxRetries: 2 });
  }

  public async create(options: {
    timeoutMilliseconds: number;
    profileId?: string;
  }): Promise<BrowserSession> {
    const request: Steel.SessionCreateParams = {
      blockAds: true,
      headless: false,
      dimensions: { width: 1440, height: 900 },
      // The branded in-page cursor is streamed with the document; suppress the
      // unbrandable OS cursor so viewers never see two pointers.
      debugConfig: { interactive: false, systemCursor: false },
      timeout: options.timeoutMilliseconds,
      ...(options.profileId ? { profileId: options.profileId } : {})
    };
    return normalizeSession(await this.client.sessions.create(request));
  }

  public async release(sessionId: string): Promise<void> {
    await this.client.sessions.release(sessionId);
  }
}

function normalizeSession(session: Steel.Session): BrowserSession {
  const websocketUrl = requireSteelUrl(session.websocketUrl, "wss:");
  const viewerUrl = requireSteelUrl(session.sessionViewerUrl, "https:");
  if (!session.id) throw new Error("Steel returned an empty session ID");
  return { id: session.id, websocketUrl, viewerUrl };
}

function requireSteelUrl(rawUrl: string, protocol: "https:" | "wss:"): string {
  const url = new URL(rawUrl);
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== protocol || (hostname !== "steel.dev" && !hostname.endsWith(".steel.dev"))) {
    throw new Error("Steel returned an untrusted session endpoint");
  }
  if (url.username || url.password)
    throw new Error("Steel returned credentials in a session endpoint");
  return url.href;
}
