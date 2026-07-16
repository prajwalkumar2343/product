import { CloudTasksClient } from "@google-cloud/tasks";

export interface TaskDispatcher {
  enqueueSession(sessionId: string): Promise<void>;
}

export class CloudTaskDispatcher implements TaskDispatcher {
  private readonly client: Pick<CloudTasksClient, "queuePath" | "createTask" | "getTask">;
  private readonly projectId: string;
  private readonly region: string;
  private readonly queue: string;
  private readonly runnerUrl: string;
  private readonly serviceAccountEmail: string | undefined;

  public constructor(options: {
    projectId: string;
    region: string;
    queue: string;
    runnerUrl: string;
    serviceAccountEmail?: string;
    client?: Pick<CloudTasksClient, "queuePath" | "createTask" | "getTask">;
  }) {
    this.projectId = options.projectId;
    this.region = options.region;
    this.queue = options.queue;
    this.runnerUrl = options.runnerUrl;
    this.serviceAccountEmail = options.serviceAccountEmail;
    this.client = options.client ?? new CloudTasksClient();
  }

  public async enqueueSession(sessionId: string): Promise<void> {
    const parent = this.client.queuePath(this.projectId, this.region, this.queue);
    const taskName = `${parent}/tasks/${sessionId}`;
    const oidcToken = this.serviceAccountEmail
      ? { serviceAccountEmail: this.serviceAccountEmail, audience: this.runnerUrl }
      : undefined;
    try {
      await this.client.createTask({
        parent,
        task: {
          name: taskName,
          dispatchDeadline: { seconds: 1_800 },
          httpRequest: {
            httpMethod: "POST",
            url: `${this.runnerUrl}/internal/run`,
            headers: { "Content-Type": "application/json" },
            body: Buffer.from(JSON.stringify({ sessionId })).toString("base64"),
            ...(oidcToken ? { oidcToken } : {})
          }
        }
      });
    } catch (error) {
      if ((error as { code?: number }).code === 6) return;
      try {
        await this.client.getTask({ name: taskName });
      } catch {
        throw error;
      }
    }
  }
}
