/**
 * Command dispatch. Every command is a pure-ish function from parsed flags to
 * one outcome; `main` decides how to print it. Domain refusals are thrown as
 * CliError and become an ok:false envelope, so a command never prints an error
 * itself and stdout stays a single, parseable channel.
 */

import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { buildBrief, speakBrief, stateDump } from "./brief.ts";
import { openBoard, resolveDatabasePath } from "./db.ts";
import { CliError, UsageError } from "./errors.ts";
import { type FlagSpec, type ParsedFlags, parseFlags } from "./flags.ts";
import * as format from "./format.ts";
import { blockersOf, containsForest, readyItems } from "./graph.ts";
import { applyGroomDraft, buildGroomExport, parseGroomDraft } from "./groom.ts";
import { buildGuide } from "./guide.ts";
import type { Placement } from "./order.ts";
import type { Environ } from "./paths.ts";
import { renderBoard } from "./render.ts";
import { rankCandidates } from "./resolve.ts";
import { Board } from "./store.ts";
import { ITEM_STATES, type Item, isOpenWork, ORIGINS, REF_RELS, RELATION_KINDS } from "./types.ts";

export interface Context {
  board: Board;
  dbPath: string;
  flags: ParsedFlags;
  env: Environ;
}

export interface CommandOutput {
  data: unknown;
  human: string;
  /** Records for --jsonl; commands without a stream shape omit it. */
  lines?: unknown[];
}

const GLOBAL: FlagSpec = {
  value: new Set(["--db"]),
  bool: new Set(["--json", "--jsonl", "--help"]),
};

function spec(value: string[] = [], bool: string[] = []): FlagSpec {
  return {
    value: new Set([...GLOBAL.value, ...value]),
    bool: new Set([...GLOBAL.bool, ...bool]),
  };
}

/** What a command that never reads the board sees: the path, but no database
 * behind it. */
export type BoardlessContext = Omit<Context, "board">;

interface Command {
  spec: FlagSpec;
  /** The discriminant, so an entry in the table below still gets its `ctx`
   * typed from which of the two shapes it is. */
  boardless?: undefined;
  run(ctx: Context): CommandOutput;
}

interface BoardlessCommand {
  spec: FlagSpec;
  /** Marks a command that needs no database, so running it is not a reason
   * for one to come into existence. */
  boardless: true;
  run(ctx: BoardlessContext): CommandOutput;
}

// --- Argument helpers ---

function positionalText(flags: ParsedFlags, what: string): string {
  const text = flags.positional.join(" ").trim();
  if (text.length === 0) throw new UsageError(`${what} is required`);
  return text;
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function requireValue(flags: ParsedFlags, flag: string): string {
  const value = flags.values[flag];
  if (value === undefined || value.trim().length === 0) {
    throw new UsageError(`--${flag} is required`);
  }
  return value.trim();
}

function optionalValue(flags: ParsedFlags, flag: string): string | undefined {
  const value = flags.values[flag];
  return value === undefined ? undefined : value;
}

function oneOf<T extends string>(value: string, allowed: readonly T[], what: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new UsageError(`${what} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

/** An ejected line is a hand-editable file, so import is a trust boundary:
 * the columns are STRICT but TEXT, and SQLite would happily seat a misspelled
 * state that every later read then has to cope with. */
function exportEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value))
    return value as T;
  throw new CliError(
    "invalid_export_value",
    `${field} is ${JSON.stringify(value)}, which is not one of ${allowed.join(", ")}`,
    `edit that line so ${field} is one of ${allowed.join(", ")}, then import again`,
  );
}

function refTarget(flags: ParsedFlags): string {
  const wiki = optionalValue(flags, "wiki");
  const url = optionalValue(flags, "url");
  const artifact = optionalValue(flags, "artifact");
  const given = [wiki, url, artifact].filter((value) => value !== undefined);
  if (given.length !== 1) {
    throw new UsageError("give exactly one of --wiki, --url, or --artifact");
  }
  if (wiki !== undefined) return `wiki:${wiki.trim()}`;
  if (artifact !== undefined) return `artifact:${artifact.trim()}`;
  const target = url!.trim();
  if (!/^https?:\/\//.test(target)) {
    throw new UsageError("--url must be an http or https URL");
  }
  return target;
}

function titleOf(board: Board): (id: string) => string {
  const titles = new Map(board.items().map((item) => [item.id, item.title]));
  return (id) => titles.get(id) ?? id;
}

function itemPayload(item: Item): Record<string, unknown> {
  return {
    id: item.id,
    label: item.label,
    title: item.title,
    topic_key: item.topicKey,
    summary: item.summary,
    tags: item.tags,
    state: item.state,
    state_reason: item.stateReason,
    origin: item.origin,
    rank: item.rank,
    claim: item.claim,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
    deleted_at: item.deletedAt,
    deleted_reason: item.deletedReason,
    revision: item.revision,
  };
}

function listing(items: readonly Item[], empty: string): CommandOutput {
  return {
    data: { items: items.map(itemPayload), count: items.length },
    human: format.itemList(items, empty),
    lines: items.map(itemPayload),
  };
}

function parsePlacement(ctx: Context): Placement {
  const to = oneOf(requireValue(ctx.flags, "to"), ["first", "next", "last", "after"], "--to");
  if (to !== "after") return { at: to };
  const anchor = ctx.flags.positional.join(" ").trim();
  if (anchor.length === 0) throw new UsageError("--to after needs an item to place against");
  return { at: "after", anchor: ctx.board.resolve(anchor).id };
}

function readInput(file: string): string {
  try {
    return readFileSync(resolvePath(file), "utf8");
  } catch (error) {
    throw new CliError("unreadable_file", `could not read ${file}: ${(error as Error).message}`);
  }
}

function writeOut(path: string | undefined, body: string, fallback: string): string {
  if (path === undefined) return fallback;
  const target = resolvePath(path);
  writeFileSync(target, body);
  return target;
}

// --- Commands ---

const COMMAND_TABLE: Record<string, Command | BoardlessCommand> = {
  add: {
    spec: spec(["--title", "--summary", "--tag", "--origin"], ["--new"]),
    run(ctx) {
      const label = positionalText(ctx.flags, "a label");
      const item = ctx.board.addItem({
        label,
        ...(optionalValue(ctx.flags, "title") === undefined
          ? {}
          : { title: ctx.flags.values["title"]! }),
        ...(optionalValue(ctx.flags, "summary") === undefined
          ? {}
          : { summary: ctx.flags.values["summary"]! }),
        tags: splitList(ctx.flags.values["tag"]),
        origin: oneOf(ctx.flags.values["origin"] ?? "human", ORIGINS, "--origin"),
        allowDuplicateTopic: ctx.flags.bools.has("new"),
      });
      return { data: itemPayload(item), human: format.itemLine(item) };
    },
  },

  edit: {
    spec: spec(["--label", "--title", "--summary"]),
    run(ctx) {
      const label = optionalValue(ctx.flags, "label");
      const title = optionalValue(ctx.flags, "title");
      const summary = optionalValue(ctx.flags, "summary");
      if (label === undefined && title === undefined && summary === undefined) {
        throw new UsageError("edit needs at least one of --label, --title, or --summary");
      }
      const item = ctx.board.resolve(positionalText(ctx.flags, "an item reference"));
      const edited = ctx.board.updateItem(item, {
        ...(label === undefined ? {} : { label }),
        ...(title === undefined ? {} : { title }),
        ...(summary === undefined ? {} : { summary }),
      });
      return { data: itemPayload(edited), human: format.itemLine(edited) };
    },
  },

  get: {
    spec: spec(),
    run(ctx) {
      const item = ctx.board.resolve(positionalText(ctx.flags, "an item reference"));
      const relations = ctx.board
        .relations()
        .filter((relation) => relation.from === item.id || relation.to === item.id);
      const refs = ctx.board.refs(item.id);
      const blockers = blockersOf(item.id, ctx.board.liveItems(), ctx.board.liveEdges());
      const ready = readyItems(ctx.board.liveItems(), ctx.board.liveEdges()).some(
        (candidate) => candidate.id === item.id,
      );
      return {
        data: {
          ...itemPayload(item),
          ready,
          relations,
          refs,
          blockers: blockers.map((blocker) => ({ id: blocker.id, title: blocker.title })),
        },
        human: format.itemDetail(item, relations, refs, titleOf(ctx.board), blockers),
      };
    },
  },

  list: {
    spec: spec(["--state", "--tag"], ["--all"]),
    run(ctx) {
      const state = ctx.flags.values["state"];
      const tag = ctx.flags.values["tag"]?.trim().toLowerCase();
      let items = ctx.board.liveItems();
      if (state !== undefined) {
        const wanted = oneOf(state, ITEM_STATES, "--state");
        items = items.filter((item) => item.state === wanted);
      } else if (!ctx.flags.bools.has("all")) {
        items = items.filter(isOpenWork);
      }
      if (tag !== undefined && tag.length > 0)
        items = items.filter((item) => item.tags.includes(tag));
      return listing(items, "nothing on the board");
    },
  },

  search: {
    spec: spec(),
    run(ctx) {
      const query = positionalText(ctx.flags, "a query").toLowerCase();
      const items = ctx.board.liveItems().filter((item) => {
        const haystack = [item.label, item.title, item.summary ?? "", item.tags.join(" ")]
          .join(" ")
          .toLowerCase();
        return haystack.includes(query);
      });
      return listing(items, "nothing matched");
    },
  },

  events: {
    spec: spec(),
    run(ctx) {
      const item = ctx.board.resolve(positionalText(ctx.flags, "an item reference"));
      const events = ctx.board.events(item.id);
      return {
        data: { item: { id: item.id, title: item.title }, events },
        human: `${item.title}  (${item.id})\n${format.eventLines(events)}`,
        lines: events,
      };
    },
  },

  resolve: {
    spec: spec(),
    run(ctx) {
      const phrase = positionalText(ctx.flags, "a phrase");
      const candidates = rankCandidates(phrase, ctx.board.items()).map((candidate) => ({
        id: candidate.item.id,
        label: candidate.item.label,
        title: candidate.item.title,
        state: candidate.item.state,
        rank: candidate.item.rank,
        removed: candidate.item.deletedAt !== null,
        matched: candidate.tier,
      }));
      return {
        data: { phrase, candidates },
        human:
          candidates.length === 0
            ? `nothing on the board matches "${phrase}"`
            : candidates
                .map(
                  (candidate) =>
                    `${candidate.matched.padEnd(9)} ${candidate.id}  ${candidate.title}`,
                )
                .join("\n"),
        lines: candidates,
      };
    },
  },

  ready: {
    spec: spec(),
    run(ctx) {
      const items = readyItems(ctx.board.openItems(), ctx.board.liveEdges());
      return listing(items, "nothing is ready");
    },
  },

  claim: {
    spec: spec(["--agent"]),
    run(ctx) {
      // Grammar is checked before the board is touched, so a missing flag is a
      // usage fault whether or not the reference happened to resolve.
      const agent = requireValue(ctx.flags, "agent");
      const item = ctx.board.resolve(positionalText(ctx.flags, "an item reference"));
      const claimed = ctx.board.transition(item, "claim", { agent });
      return { data: itemPayload(claimed), human: format.itemLine(claimed) };
    },
  },

  release: {
    spec: spec(),
    run(ctx) {
      const item = ctx.board.resolve(positionalText(ctx.flags, "an item reference"));
      const released = ctx.board.transition(item, "release");
      return { data: itemPayload(released), human: format.itemLine(released) };
    },
  },

  done: {
    spec: spec(["--note"]),
    run(ctx) {
      const item = ctx.board.resolve(positionalText(ctx.flags, "an item reference"));
      const note = optionalValue(ctx.flags, "note");
      const closed = ctx.board.transition(item, "done", note === undefined ? {} : { note });
      return { data: itemPayload(closed), human: format.itemLine(closed) };
    },
  },

  cancel: {
    spec: spec(["--reason"]),
    run(ctx) {
      const reason = requireValue(ctx.flags, "reason");
      const item = ctx.board.resolve(positionalText(ctx.flags, "an item reference"));
      const closed = ctx.board.transition(item, "cancel", { reason });
      return { data: itemPayload(closed), human: format.itemLine(closed) };
    },
  },

  supersede: {
    spec: spec(["--by", "--note"]),
    run(ctx) {
      const by = requireValue(ctx.flags, "by");
      const item = ctx.board.resolve(positionalText(ctx.flags, "an item reference"));
      const successor = ctx.board.resolve(by);
      const result = ctx.board.supersede(item, successor, optionalValue(ctx.flags, "note"));
      return {
        data: { item: itemPayload(result.item), successor: itemPayload(result.successor) },
        human: `${format.itemLine(result.item)}\n  superseded by ${result.successor.title}`,
      };
    },
  },

  wait: {
    spec: spec(["--reason"]),
    run(ctx) {
      const reason = requireValue(ctx.flags, "reason");
      const item = ctx.board.resolve(positionalText(ctx.flags, "an item reference"));
      const parked = ctx.board.transition(item, "wait", { reason });
      return { data: itemPayload(parked), human: format.itemLine(parked) };
    },
  },

  pause: {
    spec: spec(["--reason"]),
    run(ctx) {
      const reason = requireValue(ctx.flags, "reason");
      const item = ctx.board.resolve(positionalText(ctx.flags, "an item reference"));
      const paused = ctx.board.transition(item, "pause", { reason });
      return { data: itemPayload(paused), human: format.itemLine(paused) };
    },
  },

  resume: {
    spec: spec(),
    run(ctx) {
      const item = ctx.board.resolve(positionalText(ctx.flags, "an item reference"));
      const resumed = ctx.board.transition(item, "resume");
      return { data: itemPayload(resumed), human: format.itemLine(resumed) };
    },
  },

  order: {
    spec: spec(["--id", "--to"]),
    run(ctx) {
      const refs = splitList(requireValue(ctx.flags, "id"));
      if (refs.length === 0) throw new UsageError("--id needs at least one item");
      const placement = parsePlacement(ctx);
      const ids = refs.map((ref) => ctx.board.resolve(ref).id);
      const moved = ctx.board.reorder(ids, placement);
      const backlog = ctx.board.openItems();
      return {
        data: { moved: moved.map(itemPayload), backlog: backlog.map(itemPayload) },
        human: format.itemList(backlog, "nothing on the board"),
      };
    },
  },

  relate: {
    spec: spec(["--note"]),
    run(ctx) {
      const [from, kind, to] = ctx.flags.positional;
      if (from === undefined || kind === undefined || to === undefined) {
        throw new UsageError("relate takes <ref> <kind> <ref>");
      }
      const checked = oneOf(kind, RELATION_KINDS, "a relation kind");
      const relation = ctx.board.addRelation(
        ctx.board.resolve(from),
        ctx.board.resolve(to),
        checked,
        optionalValue(ctx.flags, "note"),
        "human",
      );
      const title = titleOf(ctx.board);
      return {
        data: relation,
        human: `${title(relation.from)} ${relation.kind} ${title(relation.to)}`,
      };
    },
  },

  unrelate: {
    spec: spec(),
    run(ctx) {
      const [from, kind, to] = ctx.flags.positional;
      if (from === undefined || kind === undefined || to === undefined) {
        throw new UsageError("unrelate takes <ref> <kind> <ref>");
      }
      const checked = oneOf(kind, RELATION_KINDS, "a relation kind");
      const relation = ctx.board.removeRelation(
        ctx.board.resolve(from),
        ctx.board.resolve(to),
        checked,
      );
      const title = titleOf(ctx.board);
      return {
        data: relation,
        human: `removed ${relation.kind}: ${title(relation.from)} → ${title(relation.to)}`,
      };
    },
  },

  link: {
    spec: spec(["--wiki", "--url", "--artifact", "--rel"]),
    run(ctx) {
      const rel = oneOf(ctx.flags.values["rel"] ?? "notes", REF_RELS, "--rel");
      const target = refTarget(ctx.flags);
      const item = ctx.board.resolve(positionalText(ctx.flags, "an item reference"));
      const ref = ctx.board.addRef(item, target, rel);
      return { data: ref, human: `${item.title} → ${ref.target} (${ref.rel})` };
    },
  },

  unlink: {
    spec: spec(["--wiki", "--url", "--artifact"]),
    run(ctx) {
      const target = refTarget(ctx.flags);
      const item = ctx.board.resolve(positionalText(ctx.flags, "an item reference"));
      const ref = ctx.board.removeRef(item, target);
      return { data: ref, human: `${item.title} no longer references ${ref.target}` };
    },
  },

  tree: {
    spec: spec(["--root"]),
    run(ctx) {
      const root = optionalValue(ctx.flags, "root");
      const items = ctx.board.liveItems();
      const forest =
        root === undefined
          ? containsForest(items, ctx.board.liveEdges())
          : containsForest(items, ctx.board.liveEdges(), ctx.board.resolve(root).id);
      const shape = (node: { item: Item; children: unknown[] }): unknown => ({
        id: node.item.id,
        title: node.item.title,
        state: node.item.state,
        rank: node.item.rank,
        children: (node.children as { item: Item; children: unknown[] }[]).map(shape),
      });
      return { data: { tree: forest.map(shape) }, human: format.treeText(forest) };
    },
  },

  graph: {
    spec: spec(),
    run(ctx) {
      const items = ctx.board.liveItems();
      const nodes = items.map((item) => ({
        id: item.id,
        label: item.label,
        title: item.title,
        state: item.state,
        rank: item.rank,
        tags: item.tags,
        claim: item.claim,
      }));
      const live = new Set(items.map((item) => item.id));
      const edges = ctx.board
        .relations()
        .filter((relation) => live.has(relation.from) && live.has(relation.to))
        .map((relation) => ({
          kind: relation.kind,
          from: relation.from,
          to: relation.to,
          note: relation.note,
        }));
      const refs = ctx.board.refs().filter((ref) => live.has(ref.itemId));
      return {
        data: { nodes, edges, refs },
        human: `${nodes.length} nodes, ${edges.length} edges, ${refs.length} refs`,
        lines: [
          ...nodes.map((node) => ({ type: "node", ...node })),
          ...edges.map((edge) => ({ type: "edge", ...edge })),
          ...refs.map((ref) => ({ type: "ref", ...ref })),
        ],
      };
    },
  },

  brief: {
    spec: spec([], ["--spoken"]),
    run(ctx) {
      const items = ctx.board.liveItems();
      const brief = buildBrief(items, ctx.board.liveEdges());
      const spoken = speakBrief(brief, items.filter(isOpenWork));
      return {
        data: {
          counts: brief.counts,
          groups: brief.groups.map((group) => ({
            key: group.key,
            heading: group.heading,
            items: group.items.map(itemPayload),
          })),
          blockers: brief.blockers,
          spoken,
        },
        human: ctx.flags.bools.has("spoken") ? spoken : format.briefText(brief),
      };
    },
  },

  state: {
    spec: spec(["--budget"]),
    run(ctx) {
      const raw = optionalValue(ctx.flags, "budget");
      if (raw !== undefined && !/^\d+$/.test(raw.trim())) {
        throw new UsageError("--budget takes a whole number of tokens, at least 60");
      }
      const budget = raw === undefined ? 400 : Number.parseInt(raw.trim(), 10);
      if (budget < 60) {
        throw new UsageError("--budget takes a whole number of tokens, at least 60");
      }
      const brief = buildBrief(ctx.board.liveItems(), ctx.board.liveEdges());
      const dump = stateDump(brief, budget);
      return {
        data: { counts: brief.counts, budget, dump },
        human: dump,
      };
    },
  },

  groom: {
    spec: spec(["--out"]),
    run(ctx) {
      const [sub, ...rest] = ctx.flags.positional;
      if (sub === "export") {
        const payload = buildGroomExport(ctx.board);
        const body = `${JSON.stringify(payload, null, 2)}\n`;
        const out = optionalValue(ctx.flags, "out");
        const where = writeOut(out, body, "");
        return {
          data: payload,
          human: where === "" ? body.trimEnd() : `wrote ${where}`,
        };
      }
      if (sub === "apply") {
        const file = rest.join(" ").trim();
        if (file.length === 0) throw new UsageError("groom apply takes a draft file");
        let parsed: unknown;
        try {
          parsed = JSON.parse(readInput(file));
        } catch (error) {
          throw new CliError(
            "unreadable_draft",
            `could not read ${file} as JSON: ${(error as Error).message}`,
          );
        }
        const shaped = parseGroomDraft(parsed);
        if ("violations" in shaped) {
          throw new CliError(
            "groom_refused",
            `the draft is malformed; nothing was written:\n${shaped.violations.map((line) => `  - ${line}`).join("\n")}`,
            "fix the draft and apply it again",
          );
        }
        const outcome = applyGroomDraft(ctx.board, shaped.draft);
        return {
          data: outcome,
          human:
            outcome.outcome === "already_applied"
              ? `already applied at ${outcome.appliedAt}; nothing changed`
              : `applied: ${outcome.counts.created} created, ${outcome.counts.updated} updated, ${outcome.counts.closed} closed, ${outcome.counts.relationsAdded} edges added, ${outcome.counts.relationsRemoved} removed`,
        };
      }
      throw new UsageError("groom takes export or apply");
    },
  },

  rm: {
    spec: spec(["--reason"]),
    run(ctx) {
      const reason = requireValue(ctx.flags, "reason");
      const item = ctx.board.resolve(positionalText(ctx.flags, "an item reference"));
      const removed = ctx.board.remove(item, reason);
      return {
        data: itemPayload(removed),
        human: `removed "${removed.label}" (rank ${removed.rank} kept)`,
      };
    },
  },

  restore: {
    spec: spec(["--reason"]),
    run(ctx) {
      const item = ctx.board.resolve(positionalText(ctx.flags, "an item reference"));
      const restored = ctx.board.restore(item, optionalValue(ctx.flags, "reason"));
      return { data: itemPayload(restored), human: format.itemLine(restored) };
    },
  },

  export: {
    spec: spec(["--out"]),
    run(ctx) {
      const records: unknown[] = [
        {
          type: "meta",
          version: 1,
          revision: ctx.board.revision(),
          generated_at: ctx.board.stamp(),
        },
        ...ctx.board.items().map((item) => ({ type: "item", ...itemPayload(item) })),
        ...ctx.board.events().map((event) => ({ type: "event", ...event })),
        ...ctx.board.relations().map((relation) => ({ type: "relation", ...relation })),
        ...ctx.board.refs().map((ref) => ({ type: "ref", ...ref })),
        ...ctx.board.groomings().map((audit) => ({ type: "grooming", ...audit })),
      ];
      const body = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
      const out = optionalValue(ctx.flags, "out");
      const where = writeOut(out, body, "");
      return {
        data: { records },
        human: where === "" ? body.trimEnd() : `wrote ${records.length} records to ${where}`,
        lines: records,
      };
    },
  },

  import: {
    spec: spec(),
    run(ctx) {
      const file = positionalText(ctx.flags, "a file");
      const text = readInput(file);
      const payload = {
        items: [] as any[],
        events: [] as any[],
        relations: [] as any[],
        refs: [] as any[],
        groomings: [] as any[],
      };
      for (const line of text.split("\n")) {
        if (line.trim().length === 0) continue;
        let record: Record<string, unknown>;
        try {
          record = JSON.parse(line) as Record<string, unknown>;
        } catch (error) {
          throw new CliError(
            "unreadable_export",
            `could not read a line as JSON: ${(error as Error).message}`,
          );
        }
        switch (record["type"]) {
          case "meta":
            break;
          case "item":
            payload.items.push({
              id: record["id"],
              label: record["label"],
              title: record["title"],
              topicKey: record["topic_key"],
              summary: record["summary"] ?? null,
              tags: record["tags"] ?? [],
              state: exportEnum(record["state"], ITEM_STATES, "item state"),
              stateReason: record["state_reason"] ?? null,
              origin: exportEnum(record["origin"], ORIGINS, "item origin"),
              rank: record["rank"],
              claim: record["claim"] ?? null,
              createdAt: record["created_at"],
              updatedAt: record["updated_at"],
              deletedAt: record["deleted_at"] ?? null,
              deletedReason: record["deleted_reason"] ?? null,
              revision: record["revision"],
            });
            break;
          case "event":
            payload.events.push(record);
            break;
          case "relation":
            exportEnum(record["kind"], RELATION_KINDS, "relation kind");
            payload.relations.push(record);
            break;
          case "ref":
            exportEnum(record["rel"], REF_RELS, "ref rel");
            payload.refs.push(record);
            break;
          case "grooming":
            payload.groomings.push(record);
            break;
          default:
            throw new CliError(
              "unreadable_export",
              `unknown record type: ${String(record["type"])}`,
            );
        }
      }
      ctx.board.importAll(payload);
      return {
        data: {
          items: payload.items.length,
          events: payload.events.length,
          relations: payload.relations.length,
          refs: payload.refs.length,
          groomings: payload.groomings.length,
        },
        human: `imported ${payload.items.length} items, ${payload.relations.length} relations, ${payload.refs.length} refs`,
      };
    },
  },

  render: {
    spec: spec(["--out"], ["--publish"]),
    run(ctx) {
      const items = ctx.board.liveItems();
      const html = renderBoard({
        items,
        relations: ctx.board.relations(),
        refs: ctx.board.refs(),
        tree: containsForest(items, ctx.board.liveEdges()),
        generatedAt: ctx.board.stamp(),
      });
      const out = optionalValue(ctx.flags, "out");
      const publishing = ctx.flags.bools.has("publish");
      // A publish with no --out must not litter the cwd: the snapshot goes to
      // a temp file and, once the CAS owns the bytes, the file is removed. On
      // a failed publish it stays, because the recovery command names it.
      const target = resolvePath(
        out ??
          (publishing
            ? join(tmpdir(), `agentboard-render-${process.pid}.html`)
            : "agentboard.html"),
      );
      writeFileSync(target, html);
      const published = publishing ? publish(target) : null;
      const kept = out !== undefined || !publishing;
      if (!kept) unlinkSync(target);
      return {
        data: { path: kept ? target : null, bytes: html.length, published },
        human: publishing
          ? `${kept ? `wrote ${target}\n` : ""}published: ${publishedLine(published)}`
          : `wrote ${target}`,
      };
    },
  },

  guide: {
    spec: spec(),
    boardless: true,
    run(ctx) {
      const guide = buildGuide(ctx.dbPath);
      return { data: guide, human: JSON.stringify(guide, null, 2) };
    },
  },
};

/** agentboard never serves anything; the human view is agentwiki's business.
 * The envelope is the contract across that seam, not the human lines — so this
 * asks for --json and keeps agentwiki's `data` verbatim. Parsing the printed
 * text instead would make any cosmetic edit over there a silent change to what
 * `render --publish` returns. */
function publish(file: string): unknown {
  const binary = Bun.which("agentwiki");
  if (binary === null) {
    throw new CliError(
      "agentwiki_missing",
      "agentwiki is not on PATH, so the snapshot cannot be published",
      `the file is written; publish it later with: agentwiki publish ${file} --name agentboard --kind render`,
    );
  }
  const result = Bun.spawnSync(
    [binary, "publish", file, "--name", "agentboard", "--kind", "render", "--json"],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stdout = new TextDecoder().decode(result.stdout).trim();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  let envelope: { ok?: unknown; error?: { message?: unknown; recovery?: unknown } | null };
  try {
    envelope = JSON.parse(stdout) as typeof envelope;
  } catch {
    // agentwiki prints no envelope for a usage fault (its exit 2), so a
    // failure to parse means the call itself does not match its grammar.
    throw new CliError(
      "publish_failed",
      `agentwiki publish exited ${result.exitCode} without a JSON envelope: ${stderr === "" ? stdout : stderr}`,
    );
  }
  if (envelope.ok !== true) {
    const error = envelope.error ?? {};
    const message = typeof error.message === "string" ? error.message : `exited ${result.exitCode}`;
    const recovery = typeof error.recovery === "string" ? error.recovery : undefined;
    throw new CliError("publish_failed", `agentwiki publish refused: ${message}`, recovery);
  }
  return (envelope as { data?: unknown }).data ?? null;
}

/** One published artifact, said in a line: whatever agentwiki named it. */
function publishedLine(published: unknown): string {
  const data = (published ?? {}) as Record<string, unknown>;
  const name = typeof data["name"] === "string" ? data["name"] : "agentboard";
  const version = typeof data["version"] === "string" ? data["version"].slice(0, 12) : "unknown";
  const url = typeof data["url"] === "string" ? ` ${data["url"]}` : "";
  return `${name}@${version}${url}`;
}

/** Parsed but not yet run: `main` needs the flags before the board is touched,
 * so that a domain failure prints in whichever mode the caller asked for. */
export interface PreparedCommand {
  name: string;
  flags: ParsedFlags;
}

export function parseCommand(name: string, argv: string[]): PreparedCommand {
  const command = COMMAND_TABLE[name];
  if (command === undefined) throw new UsageError(`unknown command "${name}"`);
  return { name, flags: parseFlags(argv, command.spec) };
}

export function runPrepared(
  prepared: PreparedCommand,
  env: Environ,
  home: string,
): { output: CommandOutput; close: () => void } {
  const command = COMMAND_TABLE[prepared.name]!;
  const { flags } = prepared;
  const dbPath = resolveDatabasePath(flags.values["db"], env, home);
  if (command.boardless === true) {
    return { output: command.run({ dbPath, flags, env }), close: () => {} };
  }
  const board = new Board(openBoard(dbPath));
  try {
    return { output: command.run({ board, dbPath, flags, env }), close: () => board.close() };
  } catch (error) {
    board.close();
    throw error;
  }
}

export { COMMAND_TABLE };
