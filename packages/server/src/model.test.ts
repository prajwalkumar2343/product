import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiCompatibleProvider } from "./model.js";

describe("model provider boundary", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("retries transient responses and returns validated telemetry", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(
        Response.json({
          id: "req-1",
          model: "test-model",
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call-1",
                    function: { name: "finish_demo", arguments: '{"summary":"Done"}' }
                  }
                ]
              }
            }
          ]
        })
      );
    vi.stubGlobal("fetch", fetchMock);
    const decision = await new OpenAiCompatibleProvider(
      "https://model.example.com/v1",
      "secret",
      "test-model"
    ).decide(
      [{ role: "system", content: "test" }],
      [{ name: "finish_demo", description: "finish", parameters: { type: "object" } }],
      new AbortController().signal
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(decision.toolCall?.name).toBe("finish_demo");
    expect(decision.telemetry).toEqual({
      requestId: "req-1",
      model: "test-model",
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15
    });
  });

  it("does not retry a non-retryable provider rejection", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      new OpenAiCompatibleProvider("https://model.example.com/v1", "secret", "test-model").decide(
        [],
        [],
        new AbortController().signal
      )
    ).rejects.toThrow("rejected (400)");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
