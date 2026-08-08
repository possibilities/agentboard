# 0002 — One item type, granularity by relations

A one-line snippet, a bug, and a multi-part program are the same record. What
makes one of them large is a `contains` edge, not a second type — so a captured
one-liner that turns out to be a program grows edges rather than being migrated,
and nothing has to guess which type a spoken capture meant.

The cost is that "epic" and "task" are not sayable as types; the tree view and
the relation kinds carry that meaning instead.
