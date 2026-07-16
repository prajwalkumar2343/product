import type { Integration } from "@product/contracts";

export interface ElementCapability {
  actionId: string | null;
  inputKey: string | null;
}

export function authorizeClick(
  capability: ElementCapability,
  integration: Pick<Integration, "allowedActionIds">
): void {
  if (!capability.actionId || !integration.allowedActionIds.includes(capability.actionId)) {
    throw new Error("Action denied by integration policy");
  }
}

export function authorizeFixtureInput(capability: ElementCapability, fixtureKey: string): void {
  if (capability.inputKey !== fixtureKey) throw new Error("Input denied by integration policy");
}
