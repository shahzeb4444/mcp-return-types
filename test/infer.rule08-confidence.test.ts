// SPEC §3 rule 8: confidence levels from sample count, argument diversity and age.
import { describe, expect, it } from "vitest";
import { confidence, type ConfidenceInput } from "../src/infer/confidence.js";
import { inferTool } from "../src/infer/tool.js";
import { sample } from "./infer-helpers.js";

const now = new Date("2026-11-22T12:00:00Z");
const daysAgo = (d: number): Date => new Date(now.getTime() - d * 24 * 60 * 60 * 1000);
const base: ConfidenceInput = { samples: 10, distinctArgs: 3, arraysSeen: 0, nonEmptyArrays: 0, newest: now, now };
const level = (over: Partial<ConfidenceInput>) => confidence({ ...base, ...over }).level;

describe("rule 8: confidence", () => {
  it("low with fewer than 3 samples", () => {
    expect(level({ samples: 2, distinctArgs: 2 })).toBe("low");
  });

  it("low with only 1 distinct argument set, however many samples", () => {
    expect(level({ samples: 50, distinctArgs: 1 })).toBe("low");
  });

  it("low when every array seen was empty, but not when no arrays were seen at all", () => {
    expect(level({ arraysSeen: 4, nonEmptyArrays: 0 })).toBe("low");
    expect(level({ arraysSeen: 4, nonEmptyArrays: 1 })).toBe("high");
    expect(level({ arraysSeen: 0, nonEmptyArrays: 0 })).toBe("high");
  });

  it("high needs at least 10 samples AND at least 3 distinct argument sets", () => {
    expect(level({})).toBe("high");
    expect(level({ samples: 9 })).toBe("medium");
    expect(level({ distinctArgs: 2 })).toBe("medium");
    expect(level({ samples: 3, distinctArgs: 2 })).toBe("medium");
  });

  it("drops one level when the newest sample is older than 30 days (exactly 30 is not stale)", () => {
    expect(level({ newest: daysAgo(30) })).toBe("high");
    expect(level({ newest: daysAgo(31) })).toBe("medium");
    expect(level({ samples: 5, newest: daysAgo(31) })).toBe("low");
    expect(level({ samples: 1, newest: daysAgo(90) })).toBe("low");
    expect(confidence({ ...base, newest: daysAgo(45) }).reasons).toEqual(["newest sample is 45 days old"]);
  });

  it("inferTool counts success samples, distinct argument hashes and the newest timestamp", () => {
    const ok = Array.from({ length: 10 }, (_, i) =>
      sample({ n: i }, { args: `a${i % 3}`, ts: `2026-11-${String(10 + i).padStart(2, "0")}T00:00:00.000Z` }),
    );
    const errors = Array.from({ length: 5 }, (_, i) => sample({ e: 1 }, { isError: true, args: `e${i}` }));
    const r = inferTool("t", [...ok, ...errors], { now });
    expect(r).toMatchObject({ samples: 10, distinctArgs: 3, confidence: "high", newest: "2026-11-19T00:00:00.000Z" });
    const stale = inferTool("t", ok, { now: new Date("2027-01-01T00:00:00Z") });
    expect(stale.confidence).toBe("medium");
  });
});
