// SPEC §3 rule 3: union of keys; optional (missing) and nullable (null) stay separate.
import { describe, expect, it } from "vitest";
import { fits } from "../src/infer/schema.js";
import { shapeOf } from "../src/proxy/shape.js";
import { infer } from "./infer-helpers.js";

describe("rule 3: objects", () => {
  it("lists in `required` only the keys present in 100% of samples", () => {
    const s = infer([{ id: 1, title: "a" }, { id: 2 }]);
    expect(s).toEqual({
      type: "object",
      properties: { id: { type: "integer" }, title: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    });
  });

  it("a missing key is optional but NOT nullable", () => {
    const s = infer([{ id: 1, assignee: "bob" }, { id: 2 }]);
    expect(s.required).toEqual(["id"]);
    expect(s.properties?.assignee).toEqual({ type: "string" });
  });

  it("a key present with null is nullable but still required", () => {
    const s = infer([
      { id: 1, closed_at: null },
      { id: 2, closed_at: "2026-11-01T00:00:00Z" },
    ]);
    expect(s.required).toEqual(["id", "closed_at"]);
    expect(s.properties?.closed_at).toEqual({ type: ["string", "null"], format: "date-time" });
  });

  it("a key can be both optional and nullable", () => {
    const s = infer([{ id: 1, milestone: null }, { id: 2, milestone: "v1" }, { id: 3 }]);
    expect(s.required).toEqual(["id"]);
    expect(s.properties?.milestone).toEqual({ type: ["string", "null"] });
  });

  it("an always-null key is typed null (required when always present, optional otherwise)", () => {
    expect(infer([{ next_page: null }, { next_page: null }])).toMatchObject({
      properties: { next_page: { type: "null" } },
      required: ["next_page"],
    });
    const s = infer([{ id: 1, x: null }, { id: 2 }]);
    expect(s.properties?.x).toEqual({ type: "null" });
    expect(s.required).toEqual(["id"]);
  });

  it("a nullable nested object becomes type [object, null] with its keywords kept", () => {
    const s = infer([{ user: { login: "a", id: 1 } }, { user: null }]);
    expect(s.properties?.user).toEqual({
      type: ["object", "null"],
      properties: { login: { type: "string" }, id: { type: "integer" } },
      required: ["login", "id"],
      additionalProperties: false,
    });
  });

  it("objects are closed: a key never seen does not validate (it is drift)", () => {
    const s = infer([{ id: 1 }]);
    expect(fits(shapeOf({ id: 2 }), s)).toBe(true);
    expect(fits(shapeOf({ id: 2, extra: true }), s)).toBe(false);
    expect(fits(shapeOf({}), s)).toBe(false); // missing required key
  });

  it("keeps the server's key order and handles keys like __proto__ as plain keys", () => {
    const parsed = JSON.parse('{"zeta": 1, "__proto__": "x", "alpha": 2}') as unknown;
    // Order = smallest position seen for each key (ties sorted by code unit), so it does not depend on sample order.
    const s = infer([parsed, { zeta: 3, __proto__x: 1 }]);
    expect(Object.keys(s.properties ?? {})).toEqual(["zeta", "__proto__", "__proto__x", "alpha"]);
    expect(Object.hasOwn(s.properties ?? {}, "__proto__")).toBe(true);
    expect(JSON.stringify(s)).toContain('"__proto__":{"type":"string"}');
  });
});
