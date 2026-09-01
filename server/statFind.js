// ESPN's various "athlete stats" endpoints nest a stat category's value a
// few different ways depending on which endpoint you hit, and the exact
// shape isn't documented anywhere official. Rather than hard-code one brittle
// path, this walks the response tree looking for anything that looks like a
// named stat entry matching one of the abbreviations you're after.

/**
 * Recursively search `node` for a stat entry whose abbreviation/name matches
 * one of `abbreviations` (case-insensitive), and return its numeric value.
 */
export function findStatValue(node, abbreviations, depth = 0) {
  if (node == null || depth > 6) return null;
  const wanted = abbreviations.map((a) => a.toUpperCase());

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findStatValue(item, abbreviations, depth + 1);
      if (found != null) return found;
    }
    return null;
  }

  if (typeof node === "object") {
    const label = node.abbreviation ?? node.shortDisplayName ?? node.name;
    if (label && wanted.includes(String(label).toUpperCase())) {
      const raw = node.value ?? node.displayValue;
      if (raw != null && raw !== "" && !Number.isNaN(Number(raw))) return Number(raw);
    }
    for (const key of Object.keys(node)) {
      const found = findStatValue(node[key], abbreviations, depth + 1);
      if (found != null) return found;
    }
  }
  return null;
}

/**
 * Find the index of a stat name within a `names`/`labels` array from an ESPN
 * gamelog category (case-insensitive, tries a couple of common aliases).
 */
export function findStatIndex(names, aliases) {
  if (!Array.isArray(names)) return -1;
  const upperNames = names.map((n) => String(n).toUpperCase());
  for (const alias of aliases) {
    const idx = upperNames.indexOf(alias.toUpperCase());
    if (idx !== -1) return idx;
  }
  return -1;
}
