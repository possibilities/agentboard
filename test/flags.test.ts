import { describe, expect, test } from "bun:test";
import { UsageError } from "../src/errors.ts";
import { type FlagSpec, parseFlags } from "../src/flags.ts";

const spec: FlagSpec = {
  value: new Set(["--tag", "--vault"]),
  bool: new Set(["--json", "--help"]),
};

describe("parseFlags", () => {
  test("accepts inline and separated value spellings equally", () => {
    const inline = parseFlags(["--tag=notes"], spec);
    const separated = parseFlags(["--tag", "notes"], spec);
    expect(inline.values).toEqual({ tag: "notes" });
    expect(separated.values).toEqual({ tag: "notes" });
  });

  test("collects booleans and positionals", () => {
    const parsed = parseFlags(["search", "--json", "hello world"], spec);
    expect(parsed.bools.has("json")).toBe(true);
    expect(parsed.positional).toEqual(["search", "hello world"]);
  });

  test("everything after -- is positional", () => {
    const parsed = parseFlags(["--json", "--", "--tag"], spec);
    expect(parsed.positional).toEqual(["--tag"]);
    expect(parsed.values).toEqual({});
  });

  test("unknown flag is a usage fault", () => {
    expect(() => parseFlags(["--nope"], spec)).toThrow(UsageError);
  });

  test("duplicate flag is a usage fault", () => {
    expect(() => parseFlags(["--json", "--json"], spec)).toThrow(UsageError);
  });

  test("value flag without a value is a usage fault", () => {
    expect(() => parseFlags(["--tag"], spec)).toThrow(UsageError);
    expect(() => parseFlags(["--tag", "--json"], spec)).toThrow(UsageError);
  });

  test("boolean flag with an inline value is a usage fault", () => {
    expect(() => parseFlags(["--json=yes"], spec)).toThrow(UsageError);
  });
});
