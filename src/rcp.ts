/**
 * Roku SoundBridge RCP wire client.
 *
 * Direct port of the Home Assistant component's `protocol.py` (after the
 * 2.3.1 list-result parser fix). The HA protocol module is the source of
 * truth — keep behaviour aligned with that.
 */

import { EventEmitter } from "node:events";
import { createConnection, Socket } from "node:net";
import type { Duplex } from "node:stream";

const RCP_PORT = 5555;

/** Subset of RCP-client API the entity uses. Allows easy mocking in tests. */
export interface RcpClientLike {
  isConnected: boolean;
  powerState: string;
  transportState: string;
  volume: number;
  muted: boolean;
  title: string;
  artist: string;
  album: string;
  duration: number;
  position: number;
  positionUpdatedAt: number;
  url: string;
  on(event: "change", listener: () => void): unknown;
  off(event: "change", listener: () => void): unknown;
  connect(): Promise<boolean>;
  disconnect(): Promise<void>;
  sendCommand(command: string, opts?: { waitForResponse?: boolean }): Promise<string | undefined>;
  sendPipeline(commands: string[]): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  stop(): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  setVolume(v: number): Promise<void>;
  setMute(m: boolean): Promise<void>;
  turnOn(): Promise<void>;
  turnOff(): Promise<void>;
  playPreset(n: number): Promise<void>;
  playIndex(n: number): Promise<void>;
  connectServer(idx: number): Promise<boolean>;
  setBrowseFilterAlbum(name: string): Promise<void>;
  setBrowseFilterArtist(name: string): Promise<void>;
  setBrowseFilterGenre(name: string): Promise<void>;
  listPresets(): Promise<string[]>;
  listServers(): Promise<string[]>;
  listAlbums(): Promise<string[]>;
  listArtists(): Promise<string[]>;
  listGenres(): Promise<string[]>;
  listPlaylists(): Promise<string[]>;
  listPlaylistSongs(idx: number): Promise<string[]>;
  listSongs(): Promise<string[]>;
  irDispatch(key: string): Promise<void>;
}

export interface RcpClientOptions {
  host: string;
  port?: number;
  /** Run the background poll loop. Tests usually disable. */
  poll?: boolean;
  /** Override socket factory for tests. */
  connectionFactory?: () => Duplex;
}

interface PendingResponse {
  resolve: (value: string) => void;
  reject: (reason: Error) => void;
}

type ListWaiter = {
  resolve: (items: string[]) => void;
  reject: (reason: Error) => void;
  buffer: string[];
};

const TRANSACTION_MARKERS = new Set([
  "TransactionInitiated",
  "TransactionComplete",
  "TransactionCanceled",
]);

export class RcpClient extends EventEmitter implements RcpClientLike {
  readonly host: string;
  readonly port: number;
  private readonly poll: boolean;
  private readonly connectionFactory: () => Duplex;

  private sock: Duplex | null = null;
  private rxBuffer = "";
  private connected = false;
  private connecting = false;
  private closing = false;

  private pending: Map<string, PendingResponse[]> = new Map();
  private listWaiter: ListWaiter | null = null;

  // State surfaced to the entity:
  powerState = "on";
  transportState = "stop";
  volume = 0;
  muted = false;
  title = "";
  artist = "";
  album = "";
  genre = "";
  url = "";
  duration = 0;
  position = 0;
  positionUpdatedAt = 0;
  macAddress = "";
  version = "";

  private pollTimer: NodeJS.Timeout | null = null;

  constructor(opts: RcpClientOptions) {
    super();
    this.host = opts.host;
    this.port = opts.port ?? RCP_PORT;
    this.poll = opts.poll ?? true;
    this.connectionFactory =
      opts.connectionFactory ??
      (() => createConnection({ host: this.host, port: this.port }));
  }

  get isConnected(): boolean {
    return this.connected;
  }

  // ----- Connection lifecycle -----

  async connect(): Promise<boolean> {
    if (this.connected) return true;
    if (this.connecting) {
      // Wait briefly for the in-flight connect to finish.
      for (let i = 0; i < 50 && this.connecting; i++) {
        await new Promise<void>((r) => setTimeout(r, 100));
        if (this.connected) return true;
      }
      return this.connected;
    }
    this.connecting = true;

    try {
      this.sock = this.connectionFactory();
      this.sock.on("data", (chunk: Buffer | string) => this.onData(chunk));
      this.sock.on("close", () => this.onClose());
      this.sock.on("error", (err: Error) => this.emit("error", err));

      // Wait for the banner to clear.
      await this.awaitBanner();
      this.connected = true;
      this.closing = false;
      this.emit("connect");
      this.emit("change");

      if (this.poll) this.startPollLoop();
      return true;
    } catch (err) {
      this.connecting = false;
      this.cleanup();
      throw err;
    } finally {
      this.connecting = false;
    }
  }

  async disconnect(): Promise<void> {
    this.closing = true;
    this.connected = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.cleanup();
  }

  private cleanup(): void {
    if (this.sock) {
      // Sockets that came from net.createConnection have .destroy(); plain
      // Duplex streams used in tests don't, so guard.
      const s = this.sock as Socket;
      if (typeof s.destroy === "function") s.destroy();
      this.sock = null;
    }
    this.failPending(new Error("RCP socket closed"));
  }

  private onClose(): void {
    if (!this.connected) return;
    this.connected = false;
    this.failPending(new Error("RCP socket closed"));
    this.emit("change");
    this.emit("disconnect");
  }

  private failPending(err: Error): void {
    for (const queue of this.pending.values()) {
      while (queue.length > 0) queue.shift()!.reject(err);
    }
    this.pending.clear();
    if (this.listWaiter) {
      this.listWaiter.reject(err);
      this.listWaiter = null;
    }
  }

  // ----- Banner handshake -----

  private bannerResolver: { resolve: () => void; reject: (e: Error) => void } | null = null;

  private awaitBanner(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.bannerResolver = { resolve, reject };
      // Defensive timeout in case the device never speaks.
      setTimeout(() => {
        if (this.bannerResolver) {
          this.bannerResolver.reject(new Error("RCP banner timeout"));
          this.bannerResolver = null;
        }
      }, 5000).unref?.();
    });
  }

  // ----- Wire layer -----

  private onData(chunk: Buffer | string): void {
    this.rxBuffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let idx: number;
    while ((idx = this.rxBuffer.indexOf("\n")) !== -1) {
      const raw = this.rxBuffer.slice(0, idx);
      this.rxBuffer = this.rxBuffer.slice(idx + 1);
      const line = raw.replace(/\r$/, "");
      this.parseLine(line);
    }
  }

  private parseLine(line: string): void {
    if (line.length === 0) return;

    // Banner.
    if (this.bannerResolver) {
      if (line.startsWith("roku: ready")) {
        const r = this.bannerResolver;
        this.bannerResolver = null;
        r.resolve();
        return;
      }
      // Some firmwares may send leading blank lines; ignore until banner.
      return;
    }

    // Lines without a colon: occasionally seen during list collection on
    // some firmware variants. Treat as bare list items.
    if (!line.includes(":")) {
      if (this.listWaiter) this.listWaiter.buffer.push(line);
      return;
    }

    const colon = line.indexOf(":");
    const commandKey = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    // The value half carries the list markers (this is the bug we fixed
    // in HA 2.3.1; never check command_key for ListResultSize/End).
    if (value.startsWith("ListResultSize")) {
      if (this.listWaiter) this.listWaiter.buffer = [];
      return;
    }
    if (value === "ListResultEnd") {
      if (this.listWaiter) {
        const items = this.listWaiter.buffer;
        const r = this.listWaiter.resolve;
        this.listWaiter = null;
        r(items);
      }
      return;
    }
    if (TRANSACTION_MARKERS.has(value)) return;

    // Mid-list lines are list items.
    if (this.listWaiter) {
      this.listWaiter.buffer.push(value);
      return;
    }

    // Resolve any pending sync waiter for this command.
    this.resolvePending(commandKey, value);

    // Mirror state.
    this.updateStateFromLine(commandKey, value);
    this.emit("change");
  }

  private resolvePending(commandKey: string, value: string): void {
    const queue = this.pending.get(commandKey);
    if (!queue || queue.length === 0) return;

    // GetCurrentSongInfo returns multiple lines; only resolve on a
    // terminal status (OK / GenericError) or an error inline.
    let shouldResolve = true;
    if (commandKey === "getcurrentsonginfo") {
      const lower = value.toLowerCase();
      shouldResolve =
        lower === "ok" ||
        lower === "genericerror" ||
        lower === "error" ||
        lower === "invalidcommand";
    }
    if (!shouldResolve) return;

    const p = queue.shift();
    if (p) p.resolve(value);
  }

  private updateStateFromLine(commandKey: string, value: string): void {
    switch (commandKey) {
      case "getpowerstate":
      case "playpreset": // PlayPreset response can be PowerStateOn etc.
        if (value.toLowerCase() === "powerstateon") this.powerState = "on";
        else this.powerState = value.toLowerCase();
        break;
      case "gettransportstate":
        this.transportState = value.toLowerCase();
        break;
      case "getvolume": {
        const n = Number.parseInt(value, 10);
        if (!Number.isNaN(n)) this.volume = n;
        break;
      }
      case "mute":
        if (value.toLowerCase() !== "ok") {
          this.muted = value.toLowerCase() === "on";
        }
        break;
      case "getelapsedtime":
        this.position = parseTime(value);
        this.positionUpdatedAt = Date.now() / 1000;
        break;
      case "gettotaltime":
        this.duration = parseTime(value);
        break;
      case "getmacaddress":
        this.macAddress = value;
        break;
      case "getversion":
        this.version = value;
        break;
      case "getcurrentsonginfo":
        this.parseSongInfo(value);
        break;
    }
  }

  private parseSongInfo(value: string): void {
    if (!value.includes(":")) return;
    const colon = value.indexOf(":");
    const key = value.slice(0, colon).trim().toLowerCase();
    const v = value.slice(colon + 1).trim();
    switch (key) {
      case "title":
        this.title = v;
        break;
      case "artist":
        this.artist = v;
        break;
      case "album":
        this.album = v;
        break;
      case "genre":
        this.genre = v;
        break;
      case "resource[0] url":
      case "playlisturl":
        this.url = v;
        break;
    }
  }

  // ----- Send path -----

  async sendCommand(
    command: string,
    opts: { waitForResponse?: boolean } = {},
  ): Promise<string | undefined> {
    if (!this.connected && !this.closing) await this.connect();
    if (!this.connected || !this.sock) return undefined;

    const wait = opts.waitForResponse ?? false;
    const cmdName = command.split(/\s+/, 1)[0]!.toLowerCase();

    let p: Promise<string> | null = null;
    if (wait) {
      p = new Promise<string>((resolve, reject) => {
        const queue = this.pending.get(cmdName) ?? [];
        queue.push({ resolve, reject });
        this.pending.set(cmdName, queue);
        // 5 s default timeout
        setTimeout(() => {
          const q = this.pending.get(cmdName);
          if (q) {
            const idx = q.findIndex((e) => e.reject === reject);
            if (idx !== -1) {
              q.splice(idx, 1);
              reject(new Error(`Timeout waiting for ${cmdName}`));
            }
          }
        }, 5000).unref?.();
      });
    }

    this.sock.write(`${command}\r\n`);
    return wait ? p! : undefined;
  }

  /** Send several commands as a single TCP write. */
  async sendPipeline(commands: string[]): Promise<void> {
    if (!this.connected && !this.closing) await this.connect();
    if (!this.connected || !this.sock) return;
    const payload = commands.map((c) => `${c}\r\n`).join("");
    this.sock.write(payload);
  }

  // ----- List helper -----

  private async getList(command: string): Promise<string[]> {
    if (!this.connected) return [];
    if (this.listWaiter) {
      // Cancel a stale list and start fresh.
      this.listWaiter.reject(new Error("Superseded by new list call"));
      this.listWaiter = null;
    }
    return new Promise<string[]>((resolve, reject) => {
      this.listWaiter = { resolve, reject, buffer: [] };
      this.sock!.write(`${command}\r\n`);
      setTimeout(() => {
        if (this.listWaiter && this.listWaiter.resolve === resolve) {
          this.listWaiter = null;
          reject(new Error(`Timeout for ${command}`));
        }
      }, 10000).unref?.();
    });
  }

  // ----- Public command / browse helpers -----

  async play(): Promise<void> {
    await this.sendCommand("Play");
    this.transportState = "play";
    this.emit("change");
  }
  async pause(): Promise<void> {
    await this.sendCommand("Pause");
    this.transportState = "pause";
    this.emit("change");
  }
  async stop(): Promise<void> {
    await this.sendCommand("Stop");
    this.transportState = "stop";
    this.emit("change");
  }
  async next(): Promise<void> {
    await this.sendCommand("Next");
  }
  async previous(): Promise<void> {
    await this.sendCommand("Previous");
  }
  async setVolume(v: number): Promise<void> {
    const clamped = Math.max(0, Math.min(100, Math.round(v)));
    await this.sendCommand(`SetVolume ${clamped}`);
    this.volume = clamped;
    this.emit("change");
  }
  async setMute(m: boolean): Promise<void> {
    await this.sendCommand(`Mute ${m ? "on" : "off"}`);
    this.muted = m;
    this.emit("change");
  }
  async turnOn(): Promise<void> {
    await this.sendCommand("PlayPreset 0");
    this.powerState = "on";
    this.emit("change");
  }
  async turnOff(): Promise<void> {
    await this.sendCommand("SetPowerState standby");
    this.powerState = "standby";
    this.emit("change");
  }
  async playPreset(n: number): Promise<void> {
    await this.sendCommand(`PlayPreset ${n}`);
    this.powerState = "on";
    this.emit("change");
  }
  async playIndex(n: number): Promise<void> {
    await this.sendCommand(`PlayIndex ${n}`);
    this.transportState = "play";
    this.emit("change");
  }
  async connectServer(idx: number): Promise<boolean> {
    await this.sendCommand(`ServerConnect ${idx}`);
    return true;
  }
  async setBrowseFilterAlbum(name: string): Promise<void> {
    await this.sendCommand(`SetBrowseFilterAlbum ${name}`);
  }
  async setBrowseFilterArtist(name: string): Promise<void> {
    await this.sendCommand(`SetBrowseFilterArtist ${name}`);
  }
  async setBrowseFilterGenre(name: string): Promise<void> {
    await this.sendCommand(`SetBrowseFilterGenre ${name}`);
  }
  async irDispatch(key: string): Promise<void> {
    await this.sendCommand(`IrDispatchCommand ${key}`);
  }

  listPresets(): Promise<string[]> {
    return this.getList("ListPresets");
  }
  listServers(): Promise<string[]> {
    return this.getList("ListServers");
  }
  listAlbums(): Promise<string[]> {
    return this.getList("ListAlbums");
  }
  listArtists(): Promise<string[]> {
    return this.getList("ListArtists");
  }
  listGenres(): Promise<string[]> {
    return this.getList("ListGenres");
  }
  listPlaylists(): Promise<string[]> {
    return this.getList("ListPlaylists");
  }
  listPlaylistSongs(idx: number): Promise<string[]> {
    return this.getList(`ListPlaylistSongs ${idx}`);
  }
  listSongs(): Promise<string[]> {
    return this.getList("ListSongs");
  }

  // ----- Poll loop -----

  private startPollLoop(): void {
    const tick = async () => {
      if (!this.connected) return;
      try {
        await this.sendCommand("GetPowerState");
        if (this.powerState !== "standby") {
          await this.sendCommand("GetTransportState");
          await this.sendCommand("GetVolume");
          await this.sendCommand("GetCurrentSongInfo");
          await this.sendCommand("GetElapsedTime");
          await this.sendCommand("GetTotalTime");
        }
      } catch {
        // ignore — reconnect will handle
      }
      const interval = this.transportState === "play" ? 5000 : 10000;
      this.pollTimer = setTimeout(tick, interval);
      this.pollTimer.unref?.();
    };
    void tick();
  }
}

function parseTime(s: string): number {
  const parts = s.split(":");
  try {
    if (parts.length === 3) {
      return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
    }
    if (parts.length === 2) return Number(parts[0]) * 60 + Number(parts[1]);
    if (parts.length === 1) return Number(parts[0]);
  } catch {
    /* ignore */
  }
  return 0;
}
