import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { describe, expect, it } from "vitest";
import { formatClass, MAX_ARRAY_ITEMS, sampleItems, shapeOf } from "../src/proxy/shape.js";

describe("date-time is RFC 3339 (NOTES: M3 item 1)", () => {
  const accepted = ["2026-11-22T10:00:00Z", "2026-11-22t10:00:00z", "2026-11-22T10:00:00.123+05:30", "2024-02-29T23:59:59-08:00"];
  const rejected = [
    "2026-11-22 10:00:00Z", // space instead of T
    "2026-11-22T10:00Z", // no seconds
    "2026-11-22T10:00:00", // no time zone
    "2026-11-22T10:00:00+0530", // offset without colon
    "2026-02-30T10:00:00Z", // no such day
    "2025-02-29T10:00:00Z", // not a leap year
    "2026-13-01T10:00:00Z",
    "2026-11-22T24:00:00Z",
    "2026-11-22T10:00:60Z", // leap second: not claimed
    "2026-11-22",
  ];

  it.each(accepted)("accepts %s", (s) => expect(formatClass(s)).toBe("date-time"));
  it.each(rejected)("rejects %s", (s) => expect(formatClass(s)).toBeUndefined());

  it("agrees with the strict validator that clients use (ajv-formats)", () => {
    const check = new AjvJsonSchemaValidator().getValidator({ type: "string", format: "date-time" });
    for (const s of accepted) expect(check(s).valid, s).toBe(true);
  });
});

describe("long arrays are sampled across their whole length (NOTES: M3 item 2)", () => {
  it("keeps short arrays whole and long ones at 50 evenly spaced items including first and last", () => {
    const short = Array.from({ length: MAX_ARRAY_ITEMS }, (_, i) => i);
    expect(sampleItems(short)).toEqual(short);
    const long = Array.from({ length: 1000 }, (_, i) => i);
    const picked = sampleItems(long);
    expect(picked).toHaveLength(MAX_ARRAY_ITEMS);
    expect(picked[0]).toBe(0);
    expect(picked.at(-1)).toBe(999);
    expect(new Set(picked).size).toBe(MAX_ARRAY_ITEMS);
    expect([...picked].sort((a, b) => a - b)).toEqual(picked);
  });

  it("sees a shape that only shows up at the end of a long array", () => {
    const items: unknown[] = Array.from({ length: 300 }, () => ({ id: 1 }));
    items[299] = { id: 1, extra: "late" };
    const shape = shapeOf(items);
    expect(shape).toMatchObject({ t: "array", n: 300 });
    const keys = (shape as { items: { keys: Record<string, unknown> }[] }).items.map((i) => Object.keys(i.keys).length);
    expect(keys.at(-1)).toBe(2);
  });
});
