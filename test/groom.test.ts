import { describe, expect, test } from "bun:test";
import { CliError } from "../src/errors.ts";
import {
  applyGroomDraft,
  buildGroomExport,
  type GroomDraft,
  type GroomOperation,
  groomDraftDigest,
  parseGroomDraft,
} from "../src/groom.ts";
import type { Board } from "../src/store.ts";
import { withBoard } from "./helpers.ts";

function draft(
  board: Board,
  operations: GroomOperation[],
  extra: Partial<GroomDraft> = {},
): GroomDraft {
  return {
    version: 1,
    draftId: "d-001",
    baseRevision: board.revision(),
    scope: null,
    summary: "a grooming",
    operations,
    ...extra,
  };
}

const refusal = (body: () => unknown): CliError => {
  try {
    body();
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
};

describe("parseGroomDraft", () => {
  test("collects every shape violation rather than stopping at the first", () => {
    const result = parseGroomDraft({ version: 2, draftId: "", operations: [] });
    expect("violations" in result).toBe(true);
    if (!("violations" in result)) return;
    expect(result.violations.length).toBeGreaterThan(2);
    expect(result.violations.join("\n")).toMatch(/version must be 1/);
  });

  test("refuses unknown fields on the draft and on an operation", () => {
    const base = { version: 1, draftId: "d", baseRevision: "r", scope: null, summary: "s" };
    expect(
      parseGroomDraft({
        ...base,
        nope: 1,
        operations: [{ op: "close-item", id: "x", state: "done", reason: "r" }],
      }),
    ).toMatchObject({
      violations: expect.arrayContaining([expect.stringMatching(/unknown draft field "nope"/)]),
    });
    expect(
      parseGroomDraft({
        ...base,
        operations: [{ op: "close-item", id: "x", state: "done", reason: "r", extra: 1 }],
      }),
    ).toMatchObject({
      violations: expect.arrayContaining([expect.stringMatching(/unknown field "extra"/)]),
    });
  });

  test("a scoped draft must resolve its scope, and expansions must sit outside it", () => {
    const base = {
      version: 1,
      draftId: "d",
      baseRevision: "r",
      summary: "s",
      operations: [{ op: "close-item", id: "x", state: "done", reason: "r" }],
    };
    expect(parseGroomDraft({ ...base, scope: "the auth work" })).toMatchObject({
      violations: expect.arrayContaining([expect.stringMatching(/resolve its scope/)]),
    });
    expect(
      parseGroomDraft({
        ...base,
        scope: "the auth work",
        scopeItemIds: ["x"],
        expansions: [{ id: "x", reason: "why" }],
      }),
    ).toMatchObject({
      violations: expect.arrayContaining([expect.stringMatching(/already in scopeItemIds/)]),
    });
  });

  test("a well-formed draft parses to a normalized draft", () => {
    const result = parseGroomDraft({
      version: 1,
      draftId: " d-1 ",
      baseRevision: "br1-x",
      scope: null,
      summary: " tidy ",
      operations: [{ op: "create-item", tempId: "t1", label: " a thing " }],
    });
    expect("draft" in result).toBe(true);
    if (!("draft" in result)) return;
    expect(result.draft.draftId).toBe("d-1");
    expect(result.draft.summary).toBe("tidy");
    expect(result.draft.operations[0]).toEqual({
      op: "create-item",
      tempId: "t1",
      label: "a thing",
    });
  });

  test("the digest ignores key order but not content", () => {
    const one = parseGroomDraft({
      version: 1,
      draftId: "d",
      baseRevision: "r",
      scope: null,
      summary: "s",
      operations: [{ op: "close-item", id: "x", state: "done", reason: "r" }],
    });
    const two = parseGroomDraft({
      summary: "s",
      operations: [{ reason: "r", state: "done", id: "x", op: "close-item" }],
      scope: null,
      baseRevision: "r",
      draftId: "d",
      version: 1,
    });
    if (!("draft" in one) || !("draft" in two)) throw new Error("both should parse");
    expect(groomDraftDigest(one.draft)).toBe(groomDraftDigest(two.draft));
  });
});

describe("applyGroomDraft", () => {
  test("lands every operation in one transaction, binding tempIds", () => {
    withBoard((board) => {
      const parent = board.addItem({ label: "the auth work" });
      const stale = board.addItem({ label: "the old panel" });
      const outcome = applyGroomDraft(
        board,
        draft(board, [
          { op: "create-item", tempId: "t1", label: "rotate the tokens", tags: ["auth"] },
          { op: "add-relation", kind: "contains", from: parent.id, to: "t1" },
          { op: "close-item", id: stale.id, state: "cancelled", reason: "folded in" },
        ]),
      );
      expect(outcome.outcome).toBe("applied");
      if (outcome.outcome !== "applied") return;
      expect(outcome.counts).toMatchObject({ created: 1, closed: 1, relationsAdded: 1 });
      const created = board.item(outcome.created[0]!.id)!;
      expect(created.label).toBe("rotate the tokens");
      expect(created.origin).toBe("agent");
      expect(board.item(stale.id)!.state).toBe("cancelled");
    });
  });

  test("replaying the same bytes changes nothing and reports the same ids", () => {
    withBoard((board) => {
      board.addItem({ label: "a" });
      const one = draft(board, [{ op: "create-item", tempId: "t1", label: "a new thing" }]);
      const first = applyGroomDraft(board, one);
      const revisionAfter = board.revision();
      const again = applyGroomDraft(board, one);
      expect(again.outcome).toBe("already_applied");
      expect(again.created).toEqual(first.created);
      expect(board.revision()).toBe(revisionAfter);
      expect(board.items()).toHaveLength(2);
    });
  });

  test("the same draftId carrying different bytes is refused", () => {
    withBoard((board) => {
      const one = draft(board, [{ op: "create-item", tempId: "t1", label: "a new thing" }]);
      applyGroomDraft(board, one);
      const changed = { ...one, baseRevision: board.revision(), summary: "different" };
      expect(refusal(() => applyGroomDraft(board, changed)).code).toBe("draft_conflict");
    });
  });

  test("a draft built on a board that has moved is refused", () => {
    withBoard((board) => {
      const built = draft(board, [{ op: "create-item", tempId: "t1", label: "a new thing" }]);
      board.addItem({ label: "something else" });
      expect(refusal(() => applyGroomDraft(board, built)).code).toBe("stale_draft");
    });
  });

  test("a refused draft writes nothing at all", () => {
    withBoard((board) => {
      const item = board.addItem({ label: "a" });
      const before = board.revision();
      const bad = draft(board, [
        { op: "create-item", tempId: "t1", label: "a new thing" },
        { op: "close-item", id: "it-nothing", state: "done", reason: "r" },
        { op: "update-item", id: item.id, note: "fine" },
      ]);
      const error = refusal(() => applyGroomDraft(board, bad));
      expect(error.code).toBe("groom_refused");
      expect(error.message).toMatch(/unknown item/);
      expect(board.revision()).toBe(before);
      expect(board.items()).toHaveLength(1);
    });
  });

  test("touching anything outside the declared scope is refused", () => {
    withBoard((board) => {
      const inside = board.addItem({ label: "inside" });
      const outside = board.addItem({ label: "outside" });
      const scoped = draft(
        board,
        [
          { op: "update-item", id: inside.id, note: "fine" },
          { op: "update-item", id: outside.id, note: "not fine" },
        ],
        { scope: "the inside work", scopeItemIds: [inside.id] },
      );
      expect(refusal(() => applyGroomDraft(board, scoped)).message).toMatch(
        /outside the declared scope/,
      );
    });
  });

  test("a declared expansion makes an out-of-scope touch legal", () => {
    withBoard((board) => {
      const inside = board.addItem({ label: "inside" });
      const outside = board.addItem({ label: "outside" });
      const scoped = draft(board, [{ op: "update-item", id: outside.id, note: "deliberate" }], {
        scope: "the inside work",
        scopeItemIds: [inside.id],
        expansions: [{ id: outside.id, reason: "it duplicated the inside work" }],
      });
      expect(applyGroomDraft(board, scoped).outcome).toBe("applied");
    });
  });

  test("a dependency may cross the scope boundary; containment may not", () => {
    withBoard((board) => {
      const inside = board.addItem({ label: "inside" });
      const outside = board.addItem({ label: "outside" });
      const scope = { scope: "the inside work", scopeItemIds: [inside.id] };
      expect(
        applyGroomDraft(
          board,
          draft(
            board,
            [{ op: "add-relation", kind: "depends-on", from: inside.id, to: outside.id }],
            scope,
          ),
        ).outcome,
      ).toBe("applied");
      expect(
        refusal(() =>
          applyGroomDraft(
            board,
            draft(
              board,
              [{ op: "add-relation", kind: "contains", from: inside.id, to: outside.id }],
              {
                ...scope,
                draftId: "d-002",
                baseRevision: board.revision(),
              },
            ),
          ),
        ).message,
      ).toMatch(/both endpoints inside the declared scope/);
    });
  });

  test("a draft that would close a containment loop is refused", () => {
    withBoard((board) => {
      const a = board.addItem({ label: "a" });
      const b = board.addItem({ label: "b" });
      const looping = draft(board, [
        { op: "add-relation", kind: "contains", from: a.id, to: b.id },
        { op: "add-relation", kind: "contains", from: b.id, to: a.id },
      ]);
      expect(refusal(() => applyGroomDraft(board, looping)).message).toMatch(
        /closes a contains loop/,
      );
    });
  });

  test("superseding requires the successor edge and a closed predecessor", () => {
    withBoard((board) => {
      const old = board.addItem({ label: "the old way" });
      const orphaned = draft(board, [
        { op: "close-item", id: old.id, state: "superseded", reason: "replaced" },
      ]);
      expect(refusal(() => applyGroomDraft(board, orphaned)).message).toMatch(
        /nothing supersedes it/,
      );

      const coherent = draft(board, [
        { op: "create-item", tempId: "t1", label: "the new way" },
        { op: "close-item", id: old.id, state: "superseded", reason: "replaced" },
        { op: "add-relation", kind: "supersedes", from: "t1", to: old.id },
      ]);
      expect(applyGroomDraft(board, coherent).outcome).toBe("applied");
    });
  });

  test("a draft cannot create a duplicate of an open topic", () => {
    withBoard((board) => {
      board.addItem({ label: "the auth cleanup" });
      const duplicating = draft(board, [
        { op: "create-item", tempId: "t1", label: "Auth cleanup" },
      ]);
      expect(refusal(() => applyGroomDraft(board, duplicating)).message).toMatch(
        /already open on that topic/,
      );
    });
  });

  test("grooming never touches a removed item", () => {
    withBoard((board) => {
      const gone = board.addItem({ label: "gone" });
      board.remove(gone, "not now");
      const touching = draft(board, [{ op: "update-item", id: gone.id, note: "hello" }]);
      expect(refusal(() => applyGroomDraft(board, touching)).message).toMatch(
        /removed from the board/,
      );
    });
  });

  test("the export carries the revision a draft must be built on", () => {
    withBoard((board) => {
      board.addItem({ label: "a" });
      const exported = buildGroomExport(board);
      expect(exported.baseRevision).toBe(board.revision());
      expect(exported.items).toHaveLength(1);
    });
  });

  test("the audit records the operations, the bindings, and both revisions", () => {
    withBoard((board) => {
      const a = board.addItem({ label: "a" });
      const b = board.addItem({ label: "b" });
      board.addRelation(a, b, "related-to", "first pass", "human");
      const base = board.revision();
      applyGroomDraft(
        board,
        draft(board, [{ op: "remove-relation", kind: "related-to", from: b.id, to: a.id }]),
      );
      const audit = board.grooming("d-001")!;
      expect(audit.baseRevision).toBe(base);
      expect(audit.resultRevision).toBe(board.revision());
      expect(audit.removedRelations[0]?.note).toBe("first pass");
      expect(audit.counts["relationsRemoved"]).toBe(1);
    });
  });
});
