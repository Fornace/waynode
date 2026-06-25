// URL helpers for pretty slugs: "/<spaceSlug>-<shortId>/<sessionSlug>-<shortId>"
// The short ID (last `-`-separated 8-hex chunk) is the authoritative key;
// the slug prefix is cosmetic and may go stale after a rename — the resolver
// always matches on the ID and the UI rewrites stale slugs on the fly.

/** Lowercase, dash-separated, URL-safe. Empty string if nothing usable. */
export function slugify(input: string): string {
  return (input || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-") // non-alphanumerics → dash
    .replace(/^-+|-+$/g, "")     // trim leading/trailing dashes
    .replace(/-{2,}/g, "-")      // collapse runs
    .slice(0, 48);
}

/** First 8 hex chars of a UUID — enough to disambiguate, purely presentational. */
export function shortId(id: string): string {
  return (id || "").replace(/-/g, "").slice(0, 8).toLowerCase();
}

/** `<slug>-<shortId>`, with a fallback when the name has no usable slug. */
export function slugWithId(name: string, id: string): string {
  const slug = slugify(name);
  const sid = shortId(id);
  return slug ? `${slug}-${sid}` : sid;
}

/**
 * Extract the short ID from a slug-with-id segment.
 * Returns null if the segment doesn't end in a plausible 8-hex short id.
 */
export function parseSlugSegment(segment: string | undefined): string | null {
  if (!segment) return null;
  const m = segment.match(/([0-9a-f]{8})$/i);
  return m ? m[1].toLowerCase() : null;
}
