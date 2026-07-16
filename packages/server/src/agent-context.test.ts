import { describe, expect, it } from "vitest";
import { buildBoundedModelContext } from "./agent-context.js";
import type { ModelMessage } from "./model.js";

describe("model-visible context budget", () => {
  it("keeps baseline instructions and complete recent tool pairs within the bound", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "goal" }
    ];
    for (let index = 0; index < 10; index += 1) {
      messages.push({
        role: "assistant",
        content: `call-${index}`,
        toolCall: { id: `id-${index}`, name: "inspect_page", arguments: {} }
      });
      messages.push({ role: "tool", content: "x".repeat(12_000), toolCallId: `id-${index}` });
    }
    const bounded = buildBoundedModelContext(messages);
    expect(bounded[0]?.role).toBe("system");
    expect(bounded[1]?.role).toBe("user");
    expect(
      bounded.reduce((total, message) => total + message.content.length, 0)
    ).toBeLessThanOrEqual(48_000);
    for (let index = 2; index < bounded.length; index += 1) {
      if (bounded[index]?.role === "tool") expect(bounded[index - 1]?.role).toBe("assistant");
    }
  });
});
