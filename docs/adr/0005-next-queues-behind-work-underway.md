# 0005 — "Next" queues behind everything underway

`order --to next` is the only placement that reads live state, and it is the
honest reading of "do this next": work an agent is already holding is not
displaced by reprioritizing what comes after it. An item is underway when it is
`active` — claimed and being worked. A waiting or paused item keeps its claim but
is not being worked, so it queues like any other idle item; pausing is about
attention, not priority.

The insertion point is one past the **last** item underway, not the first. That
distinction is the whole point: with two agents working, queueing behind the
first one jumps the moved run ahead of the second agent's item, so a
reprioritization silently demoted work that agent already held. It is
deliberately not a prefix length either, so an idle item sitting between two
busy ones is carried along rather than displaced, because nobody asked to
reorder it.

The scan runs over the sequence with the movers already lifted out, which is
what stops a moved in-flight item pinning itself to its own former place. With
nothing underway — or with every underway item in the same move — `next`
collapses to `first`.
