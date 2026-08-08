/**
 * Topic identity: the normalized form of a label, used to point a recapture at
 * the item that is already on the board instead of forking a duplicate.
 */

/**
 * Derive a topic key from a speakable label: lowercase, alphanumeric-joined,
 * and stripped of the leading article a speaker naturally uses, so "the auth
 * cleanup" and "Auth cleanup" are the same topic. An empty result falls back to
 * the raw trimmed label so a key is never blank.
 */
export function topicKeyFor(label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/^(the|a|an)\s+/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || label.trim().toLowerCase();
}

/** Collapse dictated whitespace: voice capture arrives with ragged spacing. */
export function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ");
}
