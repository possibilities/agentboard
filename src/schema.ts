/**
 * The storage ladder. `BOARD_SCHEMA_VERSION` is the version this code writes
 * and understands; a database stamped higher was written by a newer agentboard
 * and is refused rather than migrated backwards.
 *
 * Every table is STRICT: a board is a long-lived record, and SQLite's default
 * type affinity would let one bad write turn a state into an integer.
 */

export const BOARD_SCHEMA_VERSION = 1;

export const SCHEMA_V1 = `
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE items (
  id            TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  title         TEXT NOT NULL,
  topic_key     TEXT NOT NULL,
  summary       TEXT,
  state         TEXT NOT NULL,
  state_reason  TEXT,
  origin        TEXT NOT NULL,
  -- Dense, unique, zero-based over every row. Uniqueness is a code invariant
  -- rather than an index: a rerank rewrites the whole sequence, and SQLite
  -- checks a unique index row by row, so the intermediate states of a legal
  -- permutation would be refused.
  order_rank    INTEGER NOT NULL,
  claim_agent   TEXT,
  claim_at      TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT,
  deleted_reason TEXT,
  revision      INTEGER NOT NULL
) STRICT;

CREATE INDEX items_order ON items(order_rank);
CREATE INDEX items_topic ON items(topic_key);
CREATE INDEX items_state ON items(state);

CREATE TABLE item_tags (
  item_id TEXT NOT NULL REFERENCES items(id),
  tag     TEXT NOT NULL,
  PRIMARY KEY (item_id, tag)
) STRICT;

CREATE INDEX item_tags_tag ON item_tags(tag);

CREATE TABLE events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id  TEXT NOT NULL REFERENCES items(id),
  at       TEXT NOT NULL,
  kind     TEXT NOT NULL,
  detail   TEXT,
  revision INTEGER NOT NULL
) STRICT;

CREATE INDEX events_item ON events(item_id, id);

CREATE TABLE relations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  from_id    TEXT NOT NULL REFERENCES items(id),
  to_id      TEXT NOT NULL REFERENCES items(id),
  note       TEXT,
  origin     TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

-- Symmetric kinds are stored with their endpoints sorted, so this one index is
-- what makes "b conflicts-with a" a duplicate of "a conflicts-with b".
CREATE UNIQUE INDEX relations_edge ON relations(kind, from_id, to_id);
CREATE INDEX relations_to ON relations(to_id);

CREATE TABLE refs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    TEXT NOT NULL REFERENCES items(id),
  target     TEXT NOT NULL,
  rel        TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX refs_target ON refs(item_id, target);

-- Append-only grooming audit: never rewritten, never consulted for liveness,
-- and the reason a crashed apply can be retried without minting new ids.
CREATE TABLE groomings (
  draft_id          TEXT PRIMARY KEY,
  draft_digest      TEXT NOT NULL,
  scope             TEXT,
  scope_item_ids    TEXT,
  expansions        TEXT NOT NULL,
  summary           TEXT NOT NULL,
  operations        TEXT NOT NULL,
  removed_relations TEXT NOT NULL,
  created_bindings  TEXT NOT NULL,
  base_revision     TEXT NOT NULL,
  result_revision   TEXT NOT NULL,
  applied_at        TEXT NOT NULL,
  counts            TEXT NOT NULL
) STRICT;

INSERT INTO meta (key, value) VALUES ('schema_version', '1');
`;
