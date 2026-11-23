// SPEC §3 rule 7: formats only when 100% of observed values match (classified at record time).
import { describe, expect, it } from "vitest";
import { fits } from "../src/infer/schema.js";
import { shapeOf } from "../src/proxy/shape.js";
import { infer } from "./infer-helpers.js";

describe("rule 7: formats", () => {
  it("detects date-time, uri and email when every value matches", () => {
    expect(infer(["2026-11-22T10:00:00Z", "2025-01-01T00:00:00.123+02:00"])).toEqual({
      type: "string",
      format: "date-time",
    });
    expect(infer(["https://github.com/a/b", "http://x.test/y?z=1"])).toEqual({ type: "string", format: "uri" });
    expect(infer(["a@b.co", "someone@example.org"])).toEqual({ type: "string", format: "email" });
  });

  it("drops the format if a single value does not match (incl. an empty string)", () => {
    expect(infer(["2026-11-22T10:00:00Z", "yesterday"])).toEqual({ type: "string" });
    expect(infer(["a@b.co", ""])).toEqual({ type: "string" });
  });

  it("drops the format when values have different formats", () => {
    expect(infer(["a@b.co", "https://x.test"])).toEqual({ type: "string" });
  });

  it("keeps the format of the strings in a nullable string field", () => {
    expect(infer(["2026-11-22T10:00:00Z", null])).toEqual({ type: ["string", "null"], format: "date-time" });
  });

  it("validates format from the recorded format class", () => {
    const s = infer(["a@b.co"]);
    expect(fits(shapeOf("c@d.org"), s)).toBe(true);
    expect(fits(shapeOf("not an email"), s)).toBe(false);
  });
});
