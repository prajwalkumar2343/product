import type { CloudTasksClient } from "@google-cloud/tasks";
import { describe, expect, it, vi } from "vitest";
import { CloudTaskDispatcher } from "./tasks.js";

describe("durable task dispatch", () => {
  it("uses a deterministic name, OIDC identity, and full session deadline", async () => {
    const createTask = vi.fn().mockResolvedValue([{}]);
    const client = {
      queuePath: () => "projects/p/locations/r/queues/q",
      createTask,
      getTask: vi.fn()
    } as unknown as Pick<CloudTasksClient, "queuePath" | "createTask" | "getTask">;
    await dispatcher(client).enqueueSession("ses_123");
    expect(createTask).toHaveBeenCalledWith({
      parent: "projects/p/locations/r/queues/q",
      task: {
        name: "projects/p/locations/r/queues/q/tasks/ses_123",
        dispatchDeadline: { seconds: 1800 },
        httpRequest: {
          httpMethod: "POST",
          url: "https://runner.example.com/internal/run",
          headers: { "Content-Type": "application/json" },
          body: Buffer.from(JSON.stringify({ sessionId: "ses_123" })).toString("base64"),
          oidcToken: {
            serviceAccountEmail: "tasks@example.iam.gserviceaccount.com",
            audience: "https://runner.example.com"
          }
        }
      }
    });
  });

  it("reconciles an ambiguous create failure by reading the deterministic task", async () => {
    const client = {
      queuePath: () => "projects/p/locations/r/queues/q",
      createTask: vi.fn().mockRejectedValue(new Error("connection reset")),
      getTask: vi.fn().mockResolvedValue([{}])
    } as unknown as Pick<CloudTasksClient, "queuePath" | "createTask" | "getTask">;
    await expect(dispatcher(client).enqueueSession("ses_123")).resolves.toBeUndefined();
    expect(client.getTask).toHaveBeenCalledWith({
      name: "projects/p/locations/r/queues/q/tasks/ses_123"
    });
  });
});

function dispatcher(client: Pick<CloudTasksClient, "queuePath" | "createTask" | "getTask">) {
  return new CloudTaskDispatcher({
    projectId: "p",
    region: "r",
    queue: "q",
    runnerUrl: "https://runner.example.com",
    serviceAccountEmail: "tasks@example.iam.gserviceaccount.com",
    client
  });
}
