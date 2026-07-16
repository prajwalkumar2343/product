import { describe, expect, it } from "vitest";
import { authorizeClick, authorizeFixtureInput } from "./browser-policy.js";

const integration = { allowedActionIds: ["apply_filter"] };

describe("browser element capabilities", () => {
  it("denies unmarked and unconfigured controls by default", () => {
    expect(() => authorizeClick({ actionId: null, inputKey: null }, integration)).toThrow("denied");
    expect(() =>
      authorizeClick({ actionId: "delete_account", inputKey: null }, integration)
    ).toThrow("denied");
  });

  it("allows only the configured action and matching input fixture", () => {
    expect(() =>
      authorizeClick({ actionId: "apply_filter", inputKey: null }, integration)
    ).not.toThrow();
    expect(() =>
      authorizeFixtureInput({ actionId: null, inputKey: "search_query" }, "search_query")
    ).not.toThrow();
    expect(() =>
      authorizeFixtureInput({ actionId: null, inputKey: "email" }, "search_query")
    ).toThrow("denied");
  });
});
