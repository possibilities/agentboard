/**
 * Transition legality, pure. The store applies transitions; this module is the
 * only place that decides whether one is allowed, so the rules can be tested
 * without a database and cannot drift between commands.
 *
 * Two axes, deliberately not collapsed into one:
 *  - `state` is what is true of the work;
 *  - `claim` is who holds it.
 * `claim` sets `active`, and `release` returns the item to `open` from wherever
 * it sat. Waiting and pausing keep the claim, because an agent that hits a
 * blocker still owns the work it stopped on.
 */

import { CliError } from "./errors.ts";
import { type Item, type ItemState, isTerminal, REASON_REQUIRED_STATES } from "./types.ts";

export type Transition =
  | "claim"
  | "release"
  | "done"
  | "cancel"
  | "supersede"
  | "wait"
  | "pause"
  | "resume";

function terminalRefusal(item: Item, doing: string): CliError {
  return new CliError(
    "terminal_item",
    `"${item.label}" is ${item.state} and terminal states are frozen; ${doing} would rewrite history`,
    "capture the follow-up as a new item, or supersede this one from the new item",
  );
}

function removedRefusal(item: Item, doing: string): CliError {
  return new CliError(
    "removed_item",
    `"${item.label}" was removed from the board, so ${doing} is not possible`,
    `restore it first: agentboard restore ${item.id} --reason "..."`,
  );
}

/** Every mutation starts here: a tombstoned item is invisible to all of them. */
export function assertMutable(item: Item, doing: string): void {
  if (item.deletedAt !== null) throw removedRefusal(item, doing);
  if (isTerminal(item.state)) throw terminalRefusal(item, doing);
}

export function assertLive(item: Item, doing: string): void {
  if (item.deletedAt !== null) throw removedRefusal(item, doing);
}

export function requireReason(state: ItemState, reason: string | null | undefined): string | null {
  if (!REASON_REQUIRED_STATES.includes(state)) return reason?.trim() || null;
  const text = reason?.trim();
  if (!text) {
    throw new CliError(
      "reason_required",
      `moving an item to ${state} requires a reason; the reason is the whole content of that state`,
      `pass --reason "..."`,
    );
  }
  return text;
}

/** The state a transition lands on, refusing the ones that make no sense. */
export function nextState(item: Item, transition: Transition): ItemState {
  assertMutable(item, `${transition}ing it`);
  switch (transition) {
    case "claim":
      if (item.state !== "open") {
        throw new CliError(
          "not_claimable",
          `"${item.label}" is ${item.state}, and only open work can be claimed`,
          item.state === "active"
            ? `it is already claimed by ${item.claim?.agent ?? "another agent"}`
            : "resume it first",
        );
      }
      return "active";
    case "release":
      if (item.claim === null) {
        throw new CliError(
          "not_claimed",
          `"${item.label}" is not claimed, so there is nothing to release`,
        );
      }
      return "open";
    case "done":
      return "done";
    case "cancel":
      return "cancelled";
    case "supersede":
      return "superseded";
    case "wait":
      return "waiting";
    case "pause":
      return "paused";
    case "resume":
      if (item.state !== "waiting" && item.state !== "paused") {
        throw new CliError(
          "not_resumable",
          `"${item.label}" is ${item.state}, and only waiting or paused work resumes`,
        );
      }
      // A resumed item goes back to being worked when its holder never let go.
      return item.claim === null ? "open" : "active";
  }
}

/** Claims are taken, not given: a second holder is refused, never queued. */
export function assertClaimable(item: Item, agent: string): void {
  if (item.claim !== null && item.claim.agent !== agent) {
    throw new CliError(
      "already_claimed",
      `"${item.label}" is claimed by ${item.claim.agent}`,
      "pick another item from `agentboard ready`, or ask that agent to release it",
    );
  }
}
