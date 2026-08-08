# 0001 — SQLite is the source of truth

The product is concurrent: several agents read ready-work, claim atomically, and
write at once, and a claim granted twice is the failure that matters most. A
single JSON file rewritten under a lock cannot give that, while SQLite's
`BEGIN IMMEDIATE` takes the write lock before the first read and settles it.

The hedge against betting on this schema is that everything can leave:
`export --jsonl` ejects items including tombstones, events, relations, refs, and
the grooming audit, and `import` loads that file into an empty database.
