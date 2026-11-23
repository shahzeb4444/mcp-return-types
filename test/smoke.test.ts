import { describe, expect, it } from "vitest";
import { main, VERSION } from "../src/cli.js";

describe("scaffold", () => {
  it("exposes a version", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof main).toBe("function");
  });
});
