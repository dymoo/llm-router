import type { PublicKey } from "./types";

export const LOADED_FILTER_LABEL = "Filter loaded keys";
export const LOADED_FILTER_HINT =
  "Filters keys already loaded on this page. It does not search the rest of the database.";

export function normalizeFilter(query: string): string {
  return query.trim().toLowerCase();
}

export function filterLoadedKeys(keys: readonly PublicKey[], query: string): PublicKey[] {
  const needle = normalizeFilter(query);
  if (needle.length === 0) {
    return [...keys];
  }
  return keys.filter((key) => {
    return (
      key.name.toLowerCase().includes(needle) ||
      key.prefix.toLowerCase().includes(needle) ||
      key.id.toLowerCase().includes(needle)
    );
  });
}
