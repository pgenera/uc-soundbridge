/**
 * Browse-tree path encoding and helpers.
 *
 * The path scheme is identical to the Home Assistant component's
 * `media_content_id` so behaviour and tests are interchangeable.
 *
 *   ""                                       implicit root
 *   presets                                  18-slot preset list
 *   servers                                  list of music servers
 *   servers/<i>                              category menu for server i
 *   servers/<i>/<cat>                        items in category
 *   servers/<i>/<cat>/<urlencoded-name>      tracks under that filter
 *   servers/<i>/<cat>/<urlencoded-name>/<n>  playable leaf — track n
 *   servers/<i>/songs/<n>                    playable leaf — track n
 *   play_preset:<n>                          playable leaf — preset n
 *
 * Names with `/`, `:`, etc. are URL-encoded. Decoded on the way back.
 */

export type Category = "albums" | "artists" | "genres" | "playlists" | "songs";

export const CATEGORIES: readonly Category[] = [
  "albums",
  "artists",
  "genres",
  "playlists",
  "songs",
] as const;

export interface ServerNav {
  serverIndex: number;
  category?: Category;
  itemName?: string;
  trackIndex?: number;
}

export function encodePathSegment(name: string): string {
  return encodeURIComponent(name);
}

export function decodePathSegment(seg: string): string {
  return decodeURIComponent(seg);
}

function isCategory(s: string): s is Category {
  return (CATEGORIES as readonly string[]).includes(s);
}

/**
 * Parse a `servers/...` browse path into its parts.
 * Returns null for malformed paths (caller should handle as error).
 */
export function parseServerPath(mediaId: string): ServerNav | null {
  const parts = mediaId.split("/");
  if (parts.length < 2 || parts[0] !== "servers") return null;
  const indexStr = parts[1];
  if (indexStr === undefined) return null;
  const idx = Number.parseInt(indexStr, 10);
  if (Number.isNaN(idx) || `${idx}` !== indexStr) return null;
  const nav: ServerNav = { serverIndex: idx };

  if (parts.length >= 3) {
    const category = parts[2];
    if (category === undefined || !isCategory(category)) return null;
    nav.category = category;
  }

  if (parts.length >= 4) {
    const seg = parts[3]!;
    // For "songs", the third segment IS the track index, not an item name.
    if (nav.category === "songs") {
      const t = Number.parseInt(seg, 10);
      if (Number.isNaN(t) || `${t}` !== seg) return null;
      nav.trackIndex = t;
    } else {
      nav.itemName = decodePathSegment(seg);
    }
  }

  if (parts.length >= 5 && nav.category !== "songs") {
    const seg = parts[4]!;
    const t = Number.parseInt(seg, 10);
    if (Number.isNaN(t) || `${t}` !== seg) return null;
    nav.trackIndex = t;
  }

  return nav;
}

// Some firmware variants return unset preset slots as the literal string
// "Preset 11", "Preset 12", etc. Filter both empty/whitespace and that
// placeholder pattern.
const EMPTY_PRESET_RE = /^\s*Preset\s+\d+\s*$/i;

export function isEmptyPreset(title: string | undefined | null): boolean {
  if (!title || !title.trim()) return true;
  return EMPTY_PRESET_RE.test(title);
}

export const CATEGORY_TITLES: Record<Category, string> = {
  albums: "Albums",
  artists: "Artists",
  genres: "Genres",
  playlists: "Playlists",
  songs: "All Songs",
};
