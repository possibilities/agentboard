/**
 * Turning what someone said into one item.
 *
 * Ids are opaque and never spoken, so every `<ref>` argument is allowed to be a
 * label, a rough restatement of one, or the id an earlier command printed. The
 * tiers run strongest first and stop at the first that matches anything: an
 * exact id beats an exact label, which beats the same topic said differently,
 * which beats a phrase that merely occurs in a label. Ambiguity inside a tier
 * is refused with the candidates named — guessing between two items is how a
 * board silently records work against the wrong one.
 */

import { CliError } from "./errors.ts";
import { topicKeyFor } from "./topic.ts";

export const MATCH_TIERS = ["id", "label", "topic", "contains"] as const;
export type MatchTier = (typeof MATCH_TIERS)[number];

export interface Resolvable {
  id: string;
  label: string;
  title: string;
  topicKey: string;
  rank: number;
  deletedAt: string | null;
}

export interface Candidate<T extends Resolvable> {
  item: T;
  tier: MatchTier;
}

function fold(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function tierMatches<T extends Resolvable>(
  phrase: string,
  items: readonly T[],
  tier: MatchTier,
): T[] {
  const folded = fold(phrase);
  switch (tier) {
    case "id":
      return items.filter((item) => item.id === phrase.trim());
    case "label":
      return items.filter((item) => fold(item.label) === folded || fold(item.title) === folded);
    case "topic":
      return items.filter((item) => item.topicKey === topicKeyFor(phrase));
    case "contains":
      return folded.length === 0
        ? []
        : items.filter(
            (item) => fold(item.label).includes(folded) || fold(item.title).includes(folded),
          );
  }
}

/**
 * Every candidate, strongest tier first and board order within a tier. A
 * removed item can still be named — that is how `restore` finds one — but it
 * never outranks live work that matched the same way.
 */
export function rankCandidates<T extends Resolvable>(
  phrase: string,
  items: readonly T[],
): Candidate<T>[] {
  const seen = new Set<string>();
  const ranked: Candidate<T>[] = [];
  for (const tier of MATCH_TIERS) {
    const matches = tierMatches(phrase, items, tier)
      .filter((item) => !seen.has(item.id))
      .sort(
        (left, right) =>
          Number(left.deletedAt !== null) - Number(right.deletedAt !== null) ||
          left.rank - right.rank,
      );
    for (const item of matches) {
      seen.add(item.id);
      ranked.push({ item, tier });
    }
  }
  return ranked;
}

/** The one item a phrase names, or a refusal that names what it could have been. */
export function resolveRef<T extends Resolvable>(phrase: string, items: readonly T[]): T {
  if (phrase.trim().length === 0) {
    throw new CliError("empty_ref", "an item reference cannot be blank");
  }
  for (const tier of MATCH_TIERS) {
    const matches = tierMatches(phrase, items, tier);
    if (matches.length === 0) continue;
    // A removed item is a match of last resort within its tier: live work wins,
    // and only a phrase that names nothing live reaches the tombstones.
    const live = matches.filter((item) => item.deletedAt === null);
    const chosen = live.length > 0 ? live : matches;
    if (chosen.length === 1) return chosen[0]!;
    const named = chosen
      .slice(0, 5)
      .map((item) => `"${item.label}" (${item.id})`)
      .join(", ");
    const more = chosen.length > 5 ? `, and ${chosen.length - 5} more` : "";
    throw new CliError(
      "ambiguous_ref",
      `"${phrase}" names ${chosen.length} items: ${named}${more}`,
      "say more of the label, or use the id",
    );
  }
  throw new CliError(
    "unknown_ref",
    `nothing on the board matches "${phrase}"`,
    "run `agentboard list` to see the board, or `agentboard resolve` for near matches",
  );
}
