import type { ModelMessage } from "./model.js";

const MAX_CONTEXT_CHARACTERS = 48_000;
const MAX_MESSAGE_CHARACTERS = 36_000;

export function buildBoundedModelContext(messages: readonly ModelMessage[]): ModelMessage[] {
  const normalized = messages.map((message) => ({
    ...message,
    content:
      message.content.length > MAX_MESSAGE_CHARACTERS
        ? `${message.content.slice(0, MAX_MESSAGE_CHARACTERS)}\n[truncated]`
        : message.content
  }));
  const baseline = normalized.slice(0, 2);
  const groups: ModelMessage[][] = [];
  for (let index = 2; index < normalized.length; index += 1) {
    const message = normalized[index];
    if (!message) continue;
    if (message.role === "assistant" && normalized[index + 1]?.role === "tool") {
      groups.push([message, normalized[index + 1] as ModelMessage]);
      index += 1;
    } else {
      groups.push([message]);
    }
  }
  const selected: ModelMessage[][] = [];
  let characters = baseline.reduce((total, message) => total + message.content.length, 0);
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (!group) continue;
    const size = group.reduce((total, message) => total + message.content.length, 0);
    if (characters + size > MAX_CONTEXT_CHARACTERS) continue;
    selected.unshift(group);
    characters += size;
  }
  return [...baseline, ...selected.flat()];
}
