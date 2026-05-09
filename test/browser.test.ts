/**
 * Unit tests for browse path encoding / decoding.
 *
 * The path scheme mirrors the HA component so tests are interchangeable.
 */

import { describe, it, expect } from "vitest";

import {
  encodePathSegment,
  decodePathSegment,
  parseServerPath,
  isEmptyPreset,
  type ServerNav,
} from "../src/browser.js";

describe("path segment encoding", () => {
  it("encodes / and : safely", () => {
    expect(encodePathSegment("Some/Album: Vol 1")).toBe("Some%2FAlbum%3A%20Vol%201");
    expect(decodePathSegment("Some%2FAlbum%3A%20Vol%201")).toBe("Some/Album: Vol 1");
  });

  it("round-trips ascii names with spaces", () => {
    const name = "matt pond PA";
    expect(decodePathSegment(encodePathSegment(name))).toBe(name);
  });
});

describe("parseServerPath", () => {
  it("matches root server path", () => {
    expect(parseServerPath("servers/2")).toEqual<ServerNav>({ serverIndex: 2 });
  });

  it("matches a category", () => {
    expect(parseServerPath("servers/0/albums")).toEqual<ServerNav>({
      serverIndex: 0,
      category: "albums",
    });
  });

  it("matches a category item with URL-encoded name", () => {
    expect(parseServerPath("servers/0/albums/Some%20Album")).toEqual<ServerNav>({
      serverIndex: 0,
      category: "albums",
      itemName: "Some Album",
    });
  });

  it("matches a track index under a category item", () => {
    expect(parseServerPath("servers/0/albums/Some%20Album/4")).toEqual<ServerNav>({
      serverIndex: 0,
      category: "albums",
      itemName: "Some Album",
      trackIndex: 4,
    });
  });

  it("treats third segment of /songs/ as the track index, not an item", () => {
    expect(parseServerPath("servers/0/songs/12")).toEqual<ServerNav>({
      serverIndex: 0,
      category: "songs",
      trackIndex: 12,
    });
  });

  it("returns null for malformed paths", () => {
    expect(parseServerPath("foo/bar")).toBeNull();
    expect(parseServerPath("servers/notanint")).toBeNull();
    expect(parseServerPath("servers/0/garbage")).toBeNull();
  });
});

describe("isEmptyPreset", () => {
  it("treats empty and whitespace as empty", () => {
    expect(isEmptyPreset("")).toBe(true);
    expect(isEmptyPreset("   ")).toBe(true);
    expect(isEmptyPreset(undefined)).toBe(true);
  });

  it('treats the literal "Preset NN" placeholder as empty (case-insensitive)', () => {
    expect(isEmptyPreset("Preset 11")).toBe(true);
    expect(isEmptyPreset("preset 7")).toBe(true);
    expect(isEmptyPreset("  Preset 17  ")).toBe(true);
  });

  it("keeps real preset names", () => {
    expect(isEmptyPreset("KQED 88.5 FM San Francisco, CA")).toBe(false);
    expect(isEmptyPreset("BBC World Service")).toBe(false);
    expect(isEmptyPreset("Preset Tonight")).toBe(false); // "Preset" without trailing digits
  });
});
