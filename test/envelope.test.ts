import { describe, expect, test } from "bun:test";
import { failure, success } from "../src/envelope.ts";
import { CliError } from "../src/errors.ts";

describe("envelope", () => {
  test("success carries data and a null error", () => {
    expect(success(1, { hits: [] })).toEqual({
      schema_version: 1,
      ok: true,
      error: null,
      data: { hits: [] },
    });
  });

  test("failure carries code and message and a null data", () => {
    const envelope = failure(1, new CliError("not_found", "no such document"));
    expect(envelope).toEqual({
      schema_version: 1,
      ok: false,
      error: { code: "not_found", message: "no such document" },
      data: null,
    });
  });

  test("recovery appears only when the error provides one", () => {
    const envelope = failure(2, new CliError("locked", "vault is locked", "retry in a moment"));
    expect(envelope.error?.recovery).toBe("retry in a moment");
    const bare = failure(2, new CliError("locked", "vault is locked"));
    expect(bare.error && "recovery" in bare.error).toBe(false);
  });
});
