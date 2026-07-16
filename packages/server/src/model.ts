import { z } from "zod";

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCall?: { id: string; name: string; arguments: unknown };
}

export interface ModelTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ModelDecision {
  narration?: string;
  toolCall?: { id: string; name: string; arguments: unknown };
  telemetry?: {
    requestId?: string;
    model?: string;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

export interface ModelProvider {
  decide(
    messages: readonly ModelMessage[],
    tools: readonly ModelTool[],
    signal: AbortSignal
  ): Promise<ModelDecision>;
}

const ResponseSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
      total_tokens: z.number().int().nonnegative().optional()
    })
    .optional(),
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.object({
                id: z.string(),
                function: z.object({ name: z.string(), arguments: z.string() })
              })
            )
            .optional()
        })
      })
    )
    .min(1)
});

export class OpenAiCompatibleProvider implements ModelProvider {
  public constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string
  ) {}

  public async decide(
    messages: readonly ModelMessage[],
    tools: readonly ModelTool[],
    signal: AbortSignal
  ): Promise<ModelDecision> {
    const requestBody = JSON.stringify({
      model: this.model,
      temperature: 0.1,
      max_completion_tokens: 800,
      messages: messages.map((message) => {
        if (message.role === "tool")
          return { role: "tool", content: message.content, tool_call_id: message.toolCallId };
        if (message.role === "assistant" && message.toolCall)
          return {
            role: "assistant",
            content: message.content || null,
            tool_calls: [
              {
                id: message.toolCall.id,
                type: "function",
                function: {
                  name: message.toolCall.name,
                  arguments: JSON.stringify(message.toolCall.arguments)
                }
              }
            ]
          };
        return { role: message.role, content: message.content };
      }),
      tools: tools.map((tool) => ({ type: "function", function: tool })),
      tool_choice: "required"
    });
    const response = await this.requestWithRetry(requestBody, signal);
    const result = ResponseSchema.parse(await response.json());
    const telemetry = {
      ...(result.id ? { requestId: result.id } : {}),
      ...(result.model ? { model: result.model } : {}),
      ...(result.usage?.prompt_tokens !== undefined
        ? { promptTokens: result.usage.prompt_tokens }
        : {}),
      ...(result.usage?.completion_tokens !== undefined
        ? { completionTokens: result.usage.completion_tokens }
        : {}),
      ...(result.usage?.total_tokens !== undefined
        ? { totalTokens: result.usage.total_tokens }
        : {})
    };
    const message = result.choices[0]?.message;
    const call = message?.tool_calls?.[0];
    if (!call) return { ...(message?.content ? { narration: message.content } : {}), telemetry };
    let args: unknown;
    try {
      args = JSON.parse(call.function.arguments);
    } catch {
      throw new Error("Model returned invalid tool arguments");
    }
    return {
      ...(message.content ? { narration: message.content } : {}),
      toolCall: { id: call.id, name: call.function.name, arguments: args },
      telemetry
    };
  }

  private async requestWithRetry(body: string, signal: AbortSignal): Promise<Response> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
          body,
          signal: attemptSignal
        });
      } catch (error) {
        if (signal.aborted || attempt === 2) throw error;
        await waitBeforeRetry(attempt, signal);
        continue;
      }
      if (response.ok) return response;
      if (![408, 409, 429].includes(response.status) && response.status < 500)
        throw new Error(`Model request rejected (${response.status})`);
      if (attempt === 2) throw new Error(`Model request failed after retries (${response.status})`);
      await response.body?.cancel().catch(() => undefined);
      await waitBeforeRetry(attempt, signal);
    }
    throw new Error("Model retry loop exhausted");
  }
}

async function waitBeforeRetry(attempt: number, signal: AbortSignal): Promise<void> {
  const milliseconds = 250 * 2 ** attempt + Math.floor(Math.random() * 100);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
      },
      { once: true }
    );
  });
}
