/**
 * SoundBridge MediaPlayer entity for Unfolded Circle.
 *
 * Wraps an RCP client and exposes:
 *   - Transport / volume / mute / power
 *   - Full IR-remote parity (dpad, home/menu/back/info, numpad)
 *   - Categorical media browser (presets + library servers → albums /
 *     artists / genres / playlists → tracks)
 *   - play_media for both `play_preset:N` and `servers/<i>/...` paths
 */

import {
  BrowseMediaItem,
  BrowseResult,
  IntegrationAPI,
  KnownMediaClass,
  KnownMediaContentType,
  MediaPlayer,
  MediaPlayerAttributes,
  MediaPlayerDeviceClasses,
  MediaPlayerFeatures,
  MediaPlayerOptions,
  MediaPlayerStates,
  Pagination,
  StatusCodes,
  type BrowseOptions,
  type Paging,
} from "@unfoldedcircle/integration-api";

import {
  CATEGORIES,
  CATEGORY_TITLES,
  encodePathSegment,
  isEmptyPreset,
  parseServerPath,
  type Category,
  type ServerNav,
} from "./browser.js";
import type { RcpClientLike } from "./rcp.js";
import { resolveCommand, SIMPLE_IR_COMMANDS } from "./ir.js";

const VOLUME_STEP = 5;

const FEATURES: MediaPlayerFeatures[] = [
  MediaPlayerFeatures.OnOff,
  MediaPlayerFeatures.PlayPause,
  MediaPlayerFeatures.Stop,
  MediaPlayerFeatures.Next,
  MediaPlayerFeatures.Previous,
  MediaPlayerFeatures.Volume,
  MediaPlayerFeatures.VolumeUpDown,
  MediaPlayerFeatures.Mute,
  MediaPlayerFeatures.Unmute,
  MediaPlayerFeatures.MuteToggle,
  MediaPlayerFeatures.MediaTitle,
  MediaPlayerFeatures.MediaArtist,
  MediaPlayerFeatures.MediaAlbum,
  MediaPlayerFeatures.MediaDuration,
  MediaPlayerFeatures.MediaPosition,
  MediaPlayerFeatures.PlayMedia,
  MediaPlayerFeatures.BrowseMedia,
  MediaPlayerFeatures.Dpad,
  MediaPlayerFeatures.Home,
  MediaPlayerFeatures.Menu,
];

export class SoundBridgeMediaPlayer extends MediaPlayer {
  private readonly client: RcpClientLike;
  private readonly onClientChange: () => void;
  private readonly api: IntegrationAPI | null;

  constructor(id: string, name: string, client: RcpClientLike, api: IntegrationAPI | null = null) {
    super(id, name, {
      features: FEATURES,
      attributes: deriveAttributes(client),
      deviceClass: MediaPlayerDeviceClasses.Speaker,
      options: {
        [MediaPlayerOptions.SimpleCommands]: [...SIMPLE_IR_COMMANDS],
      },
    });
    this.client = client;
    this.api = api;
    this.onClientChange = () => this.syncAttributes();
    client.on("change", this.onClientChange);
    this.setCmdHandler((_entity, cmdId, params) =>
      this.command(cmdId, params as Record<string, unknown> | undefined),
    );
  }

  /** Sync entity attributes from current RCP client state.
   *
   * Mutating `this.attributes` alone updates the entity object in memory
   * but does NOT emit a WebSocket `attribute_changed` event — the remote
   * never learns of the new title/position/etc. The IntegrationAPI's
   * `updateEntityAttributes()` does both: merges the values and pushes
   * the change to the remote. We mirror into `this.attributes` so that
   * any get-state request still sees the latest values, but the push is
   * what the remote actually subscribes to.
   */
  private syncAttributes(): void {
    const next = deriveAttributes(this.client);
    for (const [k, v] of Object.entries(next)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.attributes as any)[k] = v;
    }
    if (this.api) {
      this.api.updateEntityAttributes(this.id, next as Record<string, string | number | boolean>);
    }
  }

  detach(): void {
    this.client.off("change", this.onClientChange);
  }

  // ---- Commands ----

  async command(
    cmdId: string,
    params?: Record<string, unknown>,
  ): Promise<StatusCodes> {
    try {
      const ir = resolveCommand(cmdId);
      if (ir) {
        await this.client.irDispatch(ir);
        return StatusCodes.Ok;
      }

      // CK_* simple commands declared in SIMPLE_IR_COMMANDS are passed
      // through to IrDispatchCommand verbatim. (The cursor_*/home/menu/back
      // entries in SIMPLE_IR_COMMANDS go through resolveCommand() above.)
      if (cmdId.startsWith("CK_")) {
        await this.client.irDispatch(cmdId);
        return StatusCodes.Ok;
      }

      switch (cmdId) {
        case "on":
          await this.client.turnOn();
          return StatusCodes.Ok;
        case "off":
          await this.client.turnOff();
          return StatusCodes.Ok;
        case "toggle":
          if (this.client.powerState === "standby") await this.client.turnOn();
          else await this.client.turnOff();
          return StatusCodes.Ok;
        case "play_pause":
          if (this.client.transportState === "play") await this.client.pause();
          else await this.client.play();
          return StatusCodes.Ok;
        case "stop":
          await this.client.stop();
          return StatusCodes.Ok;
        case "next":
          await this.client.next();
          return StatusCodes.Ok;
        case "previous":
          await this.client.previous();
          return StatusCodes.Ok;
        case "volume": {
          const v = Number(params?.volume);
          if (Number.isFinite(v)) {
            await this.client.setVolume(v);
            return StatusCodes.Ok;
          }
          return StatusCodes.BadRequest;
        }
        case "volume_up":
          await this.client.setVolume(this.client.volume + VOLUME_STEP);
          return StatusCodes.Ok;
        case "volume_down":
          await this.client.setVolume(this.client.volume - VOLUME_STEP);
          return StatusCodes.Ok;
        case "mute":
          await this.client.setMute(true);
          return StatusCodes.Ok;
        case "unmute":
          await this.client.setMute(false);
          return StatusCodes.Ok;
        case "mute_toggle":
          await this.client.setMute(!this.client.muted);
          return StatusCodes.Ok;
        case "play_media":
          return await this.handlePlayMedia(params);
        default:
          return StatusCodes.NotImplemented;
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("RCP command failed", cmdId, err);
      return StatusCodes.ServerError;
    }
  }

  private async handlePlayMedia(
    params: Record<string, unknown> | undefined,
  ): Promise<StatusCodes> {
    const mediaId = typeof params?.media_id === "string" ? params.media_id : null;
    if (!mediaId) return StatusCodes.BadRequest;

    if (mediaId.startsWith("play_preset:")) {
      const n = Number.parseInt(mediaId.slice("play_preset:".length), 10);
      if (Number.isNaN(n)) return StatusCodes.BadRequest;
      await this.client.playPreset(n);
      return StatusCodes.Ok;
    }

    if (mediaId.startsWith("servers/")) {
      const nav = parseServerPath(mediaId);
      if (!nav || nav.trackIndex === undefined) return StatusCodes.BadRequest;
      await this.playServerTrack(nav);
      return StatusCodes.Ok;
    }

    return StatusCodes.BadRequest;
  }

  private async playServerTrack(nav: ServerNav): Promise<void> {
    await this.client.connectServer(nav.serverIndex);
    await this.refreshFilteredSongList(nav);
    await this.client.playIndex(nav.trackIndex!);
  }

  private async refreshFilteredSongList(nav: ServerNav): Promise<string[]> {
    const cat = nav.category;
    const item = nav.itemName;
    if (cat === undefined || cat === "songs") {
      return this.client.listSongs();
    }
    if (cat === "albums") {
      await this.client.setBrowseFilterAlbum(item ?? "");
      return this.client.listSongs();
    }
    if (cat === "artists") {
      await this.client.setBrowseFilterArtist(item ?? "");
      return this.client.listSongs();
    }
    if (cat === "genres") {
      await this.client.setBrowseFilterGenre(item ?? "");
      return this.client.listSongs();
    }
    if (cat === "playlists") {
      // Playlist contents are addressed by index in the last
      // ListPlaylists result, so we re-list playlists, find the index,
      // and then list its songs.
      const playlists = await this.client.listPlaylists();
      const idx = item ? playlists.indexOf(item) : 0;
      const safeIdx = idx >= 0 ? idx : 0;
      return this.client.listPlaylistSongs(safeIdx);
    }
    return [];
  }

  // ---- Browse ----

  override async browse(options: BrowseOptions): Promise<StatusCodes | BrowseResult> {
    try {
      const id = options.media_id;
      if (!id || id === "root") return this.browseRoot();
      if (id === "presets") return this.browsePresets(options.paging);
      if (id === "servers") return this.browseServers(options.paging);
      const nav = parseServerPath(id);
      if (!nav) return StatusCodes.BadRequest;
      if (nav.category === undefined) return this.browseServerRoot(nav.serverIndex);
      if (nav.itemName === undefined && nav.trackIndex === undefined) {
        return this.browseCategory(nav.serverIndex, nav.category, options.paging);
      }
      return this.browseCategoryItem(nav, options.paging);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("browse() failed", options, err);
      return StatusCodes.ServerError;
    }
  }

  private browseRoot(): BrowseResult {
    const items = [
      new BrowseMediaItem("presets", "Presets", {
        media_class: KnownMediaClass.Directory,
        can_browse: true,
      }),
      new BrowseMediaItem("servers", "Servers", {
        media_class: KnownMediaClass.Directory,
        can_browse: true,
      }),
    ];
    const root = new BrowseMediaItem("", "Roku SoundBridge", {
      media_class: KnownMediaClass.Directory,
      can_browse: true,
      items,
    });
    return new BrowseResult(root, new Pagination(1, items.length, items.length));
  }

  private async browsePresets(paging: Paging): Promise<BrowseResult> {
    const presets = await this.client.listPresets();
    const visible: { idx: number; title: string }[] = [];
    presets.forEach((title, idx) => {
      if (!isEmptyPreset(title)) visible.push({ idx, title });
    });
    const window = visible.slice(paging.offset, paging.offset + paging.limit);
    const items = window.map(
      ({ idx, title }) =>
        new BrowseMediaItem(`play_preset:${idx}`, title, {
          media_class: KnownMediaClass.Music,
          media_type: KnownMediaContentType.Music,
          can_play: true,
        }),
    );
    const root = new BrowseMediaItem("presets", "Presets", {
      media_class: KnownMediaClass.Directory,
      can_browse: true,
      items,
    });
    return BrowseResult.fromPaging(root, paging, visible.length);
  }

  private async browseServers(paging: Paging): Promise<BrowseResult> {
    const servers = await this.client.listServers();
    const window = servers.slice(paging.offset, paging.offset + paging.limit);
    const items = window.map(
      (title, i) =>
        new BrowseMediaItem(`servers/${paging.offset + i}`, title, {
          media_class: KnownMediaClass.Directory,
          can_browse: true,
        }),
    );
    const root = new BrowseMediaItem("servers", "Servers", {
      media_class: KnownMediaClass.Directory,
      can_browse: true,
      items,
    });
    return BrowseResult.fromPaging(root, paging, servers.length);
  }

  private async browseServerRoot(serverIndex: number): Promise<BrowseResult> {
    await this.client.connectServer(serverIndex);
    const items = CATEGORIES.map(
      (cat) =>
        new BrowseMediaItem(`servers/${serverIndex}/${cat}`, CATEGORY_TITLES[cat], {
          media_class: KnownMediaClass.Directory,
          can_browse: true,
        }),
    );
    const root = new BrowseMediaItem(`servers/${serverIndex}`, `Server ${serverIndex}`, {
      media_class: KnownMediaClass.Directory,
      can_browse: true,
      items,
    });
    return new BrowseResult(root, new Pagination(1, items.length, items.length));
  }

  private async browseCategory(
    serverIndex: number,
    category: Category,
    paging: Paging,
  ): Promise<BrowseResult> {
    await this.client.connectServer(serverIndex);
    if (category === "songs") {
      const songs = await this.client.listSongs();
      return this.songListing(serverIndex, "songs", undefined, paging, songs);
    }

    const items = await this.fetchCategoryNames(category);
    const window = items.slice(paging.offset, paging.offset + paging.limit);
    const childClass = categoryToMediaClass(category);
    const children = window.map(
      (name, i) =>
        new BrowseMediaItem(
          `servers/${serverIndex}/${category}/${encodePathSegment(name)}`,
          name || `Item ${paging.offset + i + 1}`,
          {
            media_class: childClass,
            can_browse: true,
          },
        ),
    );
    const root = new BrowseMediaItem(
      `servers/${serverIndex}/${category}`,
      CATEGORY_TITLES[category],
      {
        media_class: KnownMediaClass.Directory,
        can_browse: true,
        items: children,
      },
    );
    return BrowseResult.fromPaging(root, paging, items.length);
  }

  private async fetchCategoryNames(category: Exclude<Category, "songs">): Promise<string[]> {
    switch (category) {
      case "albums":
        return this.client.listAlbums();
      case "artists":
        return this.client.listArtists();
      case "genres":
        return this.client.listGenres();
      case "playlists":
        return this.client.listPlaylists();
    }
  }

  private async browseCategoryItem(nav: ServerNav, paging: Paging): Promise<BrowseResult> {
    await this.client.connectServer(nav.serverIndex);
    const songs = await this.refreshFilteredSongList(nav);
    return this.songListing(
      nav.serverIndex,
      nav.category!,
      nav.itemName,
      paging,
      songs,
    );
  }

  private songListing(
    serverIndex: number,
    category: Category,
    itemName: string | undefined,
    paging: Paging,
    songs: string[],
  ): BrowseResult {
    const window = songs.slice(paging.offset, paging.offset + paging.limit);
    const encName = itemName !== undefined ? encodePathSegment(itemName) : "";
    const prefix =
      category === "songs"
        ? `servers/${serverIndex}/songs`
        : `servers/${serverIndex}/${category}/${encName}`;
    const items = window.map(
      (title, i) =>
        new BrowseMediaItem(`${prefix}/${paging.offset + i}`, title || `Track ${paging.offset + i + 1}`, {
          media_class: KnownMediaClass.Track,
          media_type: KnownMediaContentType.Music,
          can_play: true,
        }),
    );
    const containerTitle = itemName ?? CATEGORY_TITLES[category];
    const root = new BrowseMediaItem(prefix, containerTitle, {
      media_class: KnownMediaClass.Directory,
      can_browse: true,
      items,
    });
    return BrowseResult.fromPaging(root, paging, songs.length);
  }
}

function categoryToMediaClass(category: Exclude<Category, "songs">): KnownMediaClass {
  switch (category) {
    case "albums":
      return KnownMediaClass.Album;
    case "artists":
      return KnownMediaClass.Artist;
    case "genres":
      return KnownMediaClass.Genre;
    case "playlists":
      return KnownMediaClass.Playlist;
  }
}

function deriveAttributes(client: RcpClientLike): Record<string, unknown> {
  const state = mapState(client);
  return {
    [MediaPlayerAttributes.State]: state,
    [MediaPlayerAttributes.Volume]: client.volume,
    [MediaPlayerAttributes.Muted]: client.muted,
    [MediaPlayerAttributes.MediaTitle]: client.title,
    [MediaPlayerAttributes.MediaArtist]: client.artist,
    [MediaPlayerAttributes.MediaAlbum]: client.album,
    [MediaPlayerAttributes.MediaDuration]: client.duration,
    [MediaPlayerAttributes.MediaPosition]: client.position,
    // The remote uses this to interpolate the progress bar between RCP polls.
    [MediaPlayerAttributes.MediaPositionUpdatedAt]: client.positionUpdatedAt,
    [MediaPlayerAttributes.MediaId]: client.url,
    [MediaPlayerAttributes.MediaType]: "music",
  };
}

function mapState(client: RcpClientLike): MediaPlayerStates {
  if (!client.isConnected) return MediaPlayerStates.Unavailable;
  if (client.powerState === "standby") return MediaPlayerStates.Off;
  switch (client.transportState) {
    case "play":
      return MediaPlayerStates.Playing;
    case "pause":
      return MediaPlayerStates.Paused;
    case "buffering":
      return MediaPlayerStates.Buffering;
    case "stop":
      return MediaPlayerStates.On;
    default:
      return MediaPlayerStates.On;
  }
}
