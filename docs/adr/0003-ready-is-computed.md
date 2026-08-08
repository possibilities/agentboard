# 0003 — Ready is computed, never stored

Ready is a query over the `depends-on` graph run on every call: open items whose
blockers have all finished, in board order. Storing it — or storing a "blocked"
state — would require every close, removal, and edge change to remember to
recompute it, and the first missed recomputation is a board that quietly lies
about what can be picked up.

"Blocked" is therefore never a state. `waiting` exists for the different fact
that an item is parked on something outside the board, and it carries the reason
because the reason is the whole content of that state.
