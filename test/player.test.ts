/**
 * Unit tests for SoundBridgeMediaPlayer.
 *
 * Uses a hand-rolled mock RCP client that satisfies the surface our entity
 * actually touches. Avoids heavy mocking machinery so the test reads as
 * an executable spec.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  StatusCodes,
  MediaPlayerStates,
  Paging,
  type BrowseOptions,
  type BrowseResult,
} from "@unfoldedcircle/integration-api";

import { SoundBridgeMediaPlayer } from "../src/player.js";
import type { RcpClientLike } from "../src/rcp.js";

function fakeClient(overrides: Partial<RcpClientLike> = {}): RcpClientLike {
  // Sensible defaults; tests override what they need.
  const base: RcpClientLike = {
    isConnected: true,
    powerState: "on",
    transportState: "stop",
    volume: 50,
    muted: false,
    title: "",
    artist: "",
    album: "",
    duration: 0,
    position: 0,
    positionUpdatedAt: 0,
    on: vi.fn(),
    off: vi.fn(),
    connect: vi.fn(async () => true),
    disconnect: vi.fn(async () => undefined),
    sendCommand: vi.fn(async () => undefined),
    sendPipeline: vi.fn(async () => undefined),
    play: vi.fn(async () => undefined),
    pause: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    next: vi.fn(async () => undefined),
    previous: vi.fn(async () => undefined),
    setVolume: vi.fn(async () => undefined),
    setMute: vi.fn(async () => undefined),
    turnOn: vi.fn(async () => undefined),
    turnOff: vi.fn(async () => undefined),
    playPreset: vi.fn(async () => undefined),
    playIndex: vi.fn(async () => undefined),
    connectServer: vi.fn(async () => true),
    setBrowseFilterAlbum: vi.fn(async () => undefined),
    setBrowseFilterArtist: vi.fn(async () => undefined),
    setBrowseFilterGenre: vi.fn(async () => undefined),
    listPresets: vi.fn(async () => []),
    listServers: vi.fn(async () => []),
    listAlbums: vi.fn(async () => []),
    listArtists: vi.fn(async () => []),
    listGenres: vi.fn(async () => []),
    listPlaylists: vi.fn(async () => []),
    listPlaylistSongs: vi.fn(async () => []),
    listSongs: vi.fn(async () => []),
    irDispatch: vi.fn(async () => undefined),
  };
  return Object.assign(base, overrides);
}

function makePlayer(client: RcpClientLike): SoundBridgeMediaPlayer {
  return new SoundBridgeMediaPlayer("soundbridge", "Test SoundBridge", client);
}

async function browse(
  player: SoundBridgeMediaPlayer,
  media_id?: string,
): Promise<BrowseResult> {
  const opts: BrowseOptions = { media_id, paging: new Paging(1, 100) };
  const r = await player.browse(opts);
  if (typeof r === "number") {
    throw new Error(`browse() returned status ${r}`);
  }
  return r;
}

describe("browse() — root", () => {
  it("returns Presets and Servers as expandable directories", async () => {
    const player = makePlayer(fakeClient());
    const r = await browse(player);
    const titles = r.media?.items?.map((c) => c.title);
    expect(titles).toEqual(["Presets", "Servers"]);
    expect(r.media?.items?.[0]?.media_id).toBe("presets");
    expect(r.media?.items?.[1]?.media_id).toBe("servers");
  });
});

describe("browse() — presets", () => {
  it("filters empty slots and Preset NN placeholders, keeps original index", async () => {
    const client = fakeClient({
      listPresets: vi.fn(async () => [
        "KQED",
        "KCRW",
        "",
        "  ",
        "Preset 5", // unset slot reported as placeholder
        "BBC World",
        "preset 7", // case-insensitive
      ]),
    });
    const player = makePlayer(client);
    const r = await browse(player, "presets");
    const items = r.media?.items ?? [];
    expect(items.map((i) => i.title)).toEqual(["KQED", "KCRW", "BBC World"]);
    expect(items.map((i) => i.media_id)).toEqual([
      "play_preset:0",
      "play_preset:1",
      "play_preset:5",
    ]);
    items.forEach((i) => {
      expect(i.can_play).toBe(true);
      expect(i.can_browse ?? false).toBe(false);
    });
  });
});

describe("browse() — servers list", () => {
  it("returns each server as an expandable directory", async () => {
    const client = fakeClient({
      listServers: vi.fn(async () => ["Internet Radio", "MyDAAP"]),
    });
    const player = makePlayer(client);
    const r = await browse(player, "servers");
    const items = r.media?.items ?? [];
    expect(items.map((i) => i.title)).toEqual(["Internet Radio", "MyDAAP"]);
    expect(items.map((i) => i.media_id)).toEqual(["servers/0", "servers/1"]);
    items.forEach((i) => {
      expect(i.can_browse).toBe(true);
      expect(i.can_play ?? false).toBe(false);
    });
  });
});

describe("browse() — server root → category menu", () => {
  it("connects to server and lists Albums/Artists/Genres/Playlists/All Songs", async () => {
    const client = fakeClient();
    const player = makePlayer(client);
    const r = await browse(player, "servers/0");
    expect(client.connectServer).toHaveBeenCalledWith(0);
    const titles = r.media?.items?.map((i) => i.title) ?? [];
    expect(titles).toEqual(["Albums", "Artists", "Genres", "Playlists", "All Songs"]);
  });
});

describe("browse() — albums list", () => {
  it("URL-encodes album names in the child media_ids", async () => {
    const client = fakeClient({
      listAlbums: vi.fn(async () => ["Album A", "Greatest Hits / Vol 2"]),
    });
    const player = makePlayer(client);
    const r = await browse(player, "servers/0/albums");
    const ids = r.media?.items?.map((i) => i.media_id) ?? [];
    expect(ids).toEqual([
      "servers/0/albums/Album%20A",
      "servers/0/albums/Greatest%20Hits%20%2F%20Vol%202",
    ]);
  });
});

describe("browse() — songs in an album", () => {
  it("sets the album filter, lists songs, builds playable leaves", async () => {
    const client = fakeClient({
      listSongs: vi.fn(async () => ["Track 1", "Track 2", "Track 3"]),
    });
    const player = makePlayer(client);
    const r = await browse(player, "servers/0/albums/Album%20A");
    expect(client.setBrowseFilterAlbum).toHaveBeenCalledWith("Album A");
    expect(client.listSongs).toHaveBeenCalled();
    const items = r.media?.items ?? [];
    expect(items.map((i) => i.title)).toEqual(["Track 1", "Track 2", "Track 3"]);
    expect(items[2]?.media_id).toBe("servers/0/albums/Album%20A/2");
    expect(items[2]?.can_play).toBe(true);
  });
});

describe("browse() — playlist songs (name → index lookup)", () => {
  it("re-runs ListPlaylists, then ListPlaylistSongs <index>", async () => {
    const client = fakeClient({
      listPlaylists: vi.fn(async () => ["My Mix", "Workout"]),
      listPlaylistSongs: vi.fn(async () => ["P-Song 1", "P-Song 2"]),
    });
    const player = makePlayer(client);
    const r = await browse(player, "servers/0/playlists/Workout");
    expect(client.listPlaylists).toHaveBeenCalled();
    expect(client.listPlaylistSongs).toHaveBeenCalledWith(1);
    const items = r.media?.items ?? [];
    expect(items.map((i) => i.title)).toEqual(["P-Song 1", "P-Song 2"]);
  });
});

describe("command() — transport, volume, mute", () => {
  it("play_pause toggles based on current state", async () => {
    const client = fakeClient({ transportState: "play" });
    const player = makePlayer(client);
    expect(await player.command("play_pause")).toBe(StatusCodes.Ok);
    expect(client.pause).toHaveBeenCalled();

    const client2 = fakeClient({ transportState: "pause" });
    const player2 = makePlayer(client2);
    await player2.command("play_pause");
    expect(client2.play).toHaveBeenCalled();
  });

  it("volume / mute commands route to RCP", async () => {
    const client = fakeClient({ volume: 50 });
    const player = makePlayer(client);

    await player.command("volume", { volume: 80 });
    expect(client.setVolume).toHaveBeenCalledWith(80);

    await player.command("volume_up");
    expect(client.setVolume).toHaveBeenCalledWith(55); // default step 5

    await player.command("mute");
    expect(client.setMute).toHaveBeenCalledWith(true);

    await player.command("unmute");
    expect(client.setMute).toHaveBeenCalledWith(false);
  });
});

describe("command() — IR remote parity", () => {
  it("dpad and home/menu/back/info dispatch IR keys", async () => {
    const client = fakeClient();
    const player = makePlayer(client);
    const cases: Array<[string, string]> = [
      ["cursor_up", "IR_KEY_UP"],
      ["cursor_down", "IR_KEY_DOWN"],
      ["cursor_left", "IR_KEY_LEFT"],
      ["cursor_right", "IR_KEY_RIGHT"],
      ["cursor_enter", "IR_KEY_OK"],
      ["home", "IR_KEY_HOME"],
      ["menu", "IR_KEY_BROWSE"],
      ["back", "IR_KEY_BACK"],
      ["info", "IR_KEY_DISPLAY"],
    ];
    for (const [cmd, key] of cases) {
      await player.command(cmd);
      expect(client.irDispatch).toHaveBeenCalledWith(key);
    }
  });

  it("digit_0..9 dispatch IR_KEY_<n>", async () => {
    const client = fakeClient();
    const player = makePlayer(client);
    for (let n = 0; n < 10; n++) {
      await player.command(`digit_${n}`);
      expect(client.irDispatch).toHaveBeenCalledWith(`IR_KEY_${n}`);
    }
  });
});

describe("command() — play_media", () => {
  it("play_preset:N plays preset N directly", async () => {
    const client = fakeClient();
    const player = makePlayer(client);
    expect(await player.command("play_media", { media_id: "play_preset:3" })).toBe(StatusCodes.Ok);
    expect(client.playPreset).toHaveBeenCalledWith(3);
  });

  it("server album track: connect → setBrowseFilterAlbum → listSongs → playIndex", async () => {
    const client = fakeClient();
    const player = makePlayer(client);
    await player.command("play_media", { media_id: "servers/0/albums/Album%20A/2" });
    expect(client.connectServer).toHaveBeenCalledWith(0);
    expect(client.setBrowseFilterAlbum).toHaveBeenCalledWith("Album A");
    expect(client.listSongs).toHaveBeenCalled();
    expect(client.playIndex).toHaveBeenCalledWith(2);
  });

  it("returns BAD_REQUEST when media_id is missing or unrecognised", async () => {
    const player = makePlayer(fakeClient());
    expect(await player.command("play_media", {})).toBe(StatusCodes.BadRequest);
    expect(await player.command("play_media", { media_id: "nope" })).toBe(StatusCodes.BadRequest);
  });
});

describe("attribute mapping", () => {
  it("maps RCP transport state to UC MediaPlayerStates", async () => {
    const client = fakeClient({ transportState: "play", powerState: "on" });
    const player = makePlayer(client);
    expect(player.attributes.state).toBe(MediaPlayerStates.Playing);

    const offClient = fakeClient({ powerState: "standby" });
    const offPlayer = makePlayer(offClient);
    expect(offPlayer.attributes.state).toBe(MediaPlayerStates.Off);
  });
});
