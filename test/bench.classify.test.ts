import { describe, expect, it } from "vitest";
import { classifyException, codePaginates, isRefusal, knownFieldsFromSchemas, parentsOf, schemaFieldNames } from "../bench/analysis/classify.js";
import { loadKnownFields } from "../bench/analyze.js";

const known = new Set(["items", "next_page", "assignee", "login", "labels", "name", "user", "milestone", "title", "comments"]);
const ex = (message: string, code?: string) => classifyException({ status: "exception", message, code }, known);

describe("classifyException", () => {
  it("timeouts, by status and by message", () => {
    expect(classifyException({ status: "timeout", message: "Timeout: the code did not finish within 20 s and was stopped" }, known)).toBe("timeout");
    expect(ex("Timeout: the code did not finish within 20 s and was stopped")).toBe("timeout");
  });
  it("reading a property of undefined or null", () => {
    expect(ex("TypeError: Cannot read properties of undefined (reading 'login')", "for (const i of r.items) out.push(i.assignee.login);")).toBe("undefined-or-null-property");
    expect(ex("TypeError: Cannot read properties of null (reading 'title')")).toBe("undefined-or-null-property");
    expect(ex("TypeError: Cannot destructure property 'items' of 'undefined' as it is undefined.")).toBe("undefined-or-null-property");
    expect(ex("TypeError: Cannot convert undefined or null to object")).toBe("undefined-or-null-property");
    expect(ex("TypeError: Cannot use 'in' operator to search for 'x' in undefined")).toBe("undefined-or-null-property");
  });
  it("a read through a field the server never returns is a wrong field name", () => {
    expect(ex("TypeError: Cannot read properties of undefined (reading 'length')", "const r = await tools.list_issues({repo}); return r.issues.length;")).toBe("wrong-field-name");
    expect(ex("TypeError: Cannot read properties of undefined (reading 'login')", "return x['author'].login;")).toBe("wrong-field-name");
    // a known optional field stays a read of undefined
    expect(ex("TypeError: Cannot read properties of undefined (reading 'login')", "return x.author.login + x.assignee.login;")).toBe("undefined-or-null-property");
    // no code: no refinement
    expect(ex("TypeError: Cannot read properties of undefined (reading 'length')")).toBe("undefined-or-null-property");
  });
  it("method or iteration on the wrong type", () => {
    expect(ex("TypeError: r.map is not a function")).toBe("wrong-type-method");
    expect(ex("TypeError: r is not iterable")).toBe("wrong-type-method");
    expect(ex("TypeError: res.items.filter is not a function")).toBe("wrong-type-method");
  });
  it("JSON.parse and string-vs-object confusion", () => {
    expect(ex(`SyntaxError: Unexpected token 'o', "[object Obj"... is not valid JSON`)).toBe("json-or-string-vs-object");
    expect(ex(`SyntaxError: "undefined" is not valid JSON`)).toBe("json-or-string-vs-object");
    expect(ex("SyntaxError: Unexpected end of JSON input")).toBe("json-or-string-vs-object");
    expect(ex("TypeError: Cannot create property 'x' on string '{\"a\":1}'")).toBe("json-or-string-vs-object");
    expect(ex("TypeError: Cannot use 'in' operator to search for 'items' in {\"items\":[]}")).toBe("json-or-string-vs-object");
  });
  it("wrong argument or tool names (tool errors and the sandbox)", () => {
    expect(ex('Error: missing required argument "repo"')).toBe("wrong-field-name");
    expect(ex('Error: argument "number" must be an integer')).toBe("wrong-field-name");
    expect(ex('Error: Validation Failed: unknown qualifier "status:"')).toBe("wrong-field-name");
    expect(ex("TypeError: tools.get_issues is not a function")).toBe("wrong-field-name");
  });
  it("pagination: a bad page argument", () => {
    expect(ex('Error: argument "page" must be at least 1')).toBe("pagination");
    expect(ex('Error: argument "page" must be an integer')).toBe("pagination");
  });
  it("other tool errors", () => {
    expect(ex('Error: Not Found: issue #9999 does not exist in acme/api')).toBe("tool-error");
    expect(ex('Error: Validation Failed: label "urgent" does not exist')).toBe("tool-error");
  });
  it("syntax errors that are not JSON", () => {
    expect(ex("SyntaxError: ')' expected. (line 3, column 7)")).toBe("syntax-error");
  });
  it("everything else", () => {
    expect(ex("ReferenceError: foo is not defined")).toBe("other");
    expect(ex("Error: no matching issue")).toBe("other");
    expect(ex("SandboxError: the sandbox process exited (code 1)")).toBe("other");
    expect(ex("")).toBe("other");
  });
});

describe("parentsOf", () => {
  it("finds dotted and bracketed parents of a property", () => {
    expect(parentsOf("a.b.c; x.y.c; z['w'].c; q.c", "c").sort()).toEqual(["b", "w", "y"]);
    expect(parentsOf("a.b.cd", "c")).toEqual([]);
  });
});

describe("known fields", () => {
  it("walks properties, items, anyOf and additionalProperties", () => {
    const s = { type: "object", properties: { items: { type: "array", items: { anyOf: [{ properties: { a: {} } }, { properties: { b: { additionalProperties: { properties: { c: {} } } } } }] } } } };
    expect([...schemaFieldNames(s)].sort()).toEqual(["a", "b", "c", "items"]);
    expect([...knownFieldsFromSchemas({ tools: { t: { schema: s, error: { schema: { properties: { message: {} } } } } } })].sort()).toEqual(["a", "b", "c", "items", "message"]);
  });
  it("the committed arm D schemas know the mock's real field names", () => {
    const f = loadKnownFields();
    for (const k of ["items", "next_page", "assignee", "login", "labels", "milestone", "closed_at"]) expect(f.has(k)).toBe(true);
    expect(f.has("issues")).toBe(false);
  });
});

describe("isRefusal", () => {
  it("flags failed answers that claim the tools are unavailable (real gpt-6-luna smoke answers)", () => {
    for (const t of [
      "I can’t retrieve issue #42 because the issue lookup tool isn’t available in this session.",
      "I can’t retrieve the issue data: the harness does not expose the listed issue tools (`list_issues` and `search_issues` are unavailable), so I can’t determine the count.",
      "Unable to determine with the available tools.",
      "I couldn’t retrieve the issue list, so I can’t give a reliable total.",
      "I can't determine the count because `run_code` is not available in this session.",
      "I don't have access to the GitHub tools.",
    ]) {
      expect(isRefusal(t, false), t).toBe(true);
    }
  });
  it("does not flag ordinary wrong answers, passes or missing finals", () => {
    expect(isRefusal("517", false)).toBe(false);
    expect(isRefusal('["alice","bob"]', false)).toBe(false);
    expect(isRefusal("done", false)).toBe(false);
    expect(isRefusal("No issue matches the criteria.", false)).toBe(false);
    expect(isRefusal("the tool isn't available", true)).toBe(false);
    expect(isRefusal(null, false)).toBe(false);
  });
});

describe("codePaginates", () => {
  it("sees next_page or a page other than 1", () => {
    expect(codePaginates(["let p = 1; while (p) { const r = await tools.list_issues({repo, page: p}); p = r.next_page; }"])).toBe(true);
    expect(codePaginates(["await tools.list_issues({repo, page: 2})"])).toBe(true);
    expect(codePaginates(["await tools.list_issues({repo, page})"])).toBe(true);
    expect(codePaginates(["const r = await tools.list_issues({repo}); return r.items.length;"])).toBe(false);
    expect(codePaginates(["await tools.list_issues({repo, page: 1})", "await tools.list_issues({ page: 1 })"])).toBe(false);
    expect(codePaginates(["await tools.list_issues({repo, page: 10})"])).toBe(true);
    expect(codePaginates([])).toBe(false);
  });
});
