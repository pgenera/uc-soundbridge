/**
 * Unit tests for the RCP wire client.
 *
 * The client takes a `connectionFactory` so we can plug in a fake duplex
 * stream instead of opening a real TCP socket. The fake stream:
 *   - records every chunk written to it
 *   - lets the test push fake server-side lines back to the client via
 *     `pushLine()` (each call emits one `\r\n`-terminated line).
 *
 * This matches the HA `protocol.py` test pattern but in TS.
 */

import { Duplex } from "node:stream";
import { describe, it, expect, beforeEach, vi } from "vitest";

import { RcpClient } from "../src/rcp.js";

class FakeSocket extends Duplex {
  public written: string[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override _write(chunk: any, _enc: BufferEncoding, cb: (e?: Error) => void): void {
    this.written.push(chunk.toString());
    cb();
  }

  override _read(): void {
    /* push driven externally */
  }

  pushLine(line: string): void {
    this.push(`${line}\r\n`);
  }

  /** Fire the banner the device sends right after TCP accept. */
  acceptBanner(): void {
    this.pushLine("roku: ready");
  }

  /** Convenience: every TX line, with trailing CRLF stripped. */
  txLines(): string[] {
    return this.written.join("").split("\r\n").filter((l) => l.length > 0);
  }
}

function makeClient(): { client: RcpClient; sock: FakeSocket } {
  const sock = new FakeSocket();
  const client = new RcpClient({
    host: "device.local",
    port: 5555,
    // Disable the background poll loop so tests don't have to deal with it.
    poll: false,
    connectionFactory: () => sock,
  });
  return { client, sock };
}

describe("RcpClient banner + framing", () => {
  it("connects after the banner arrives and writes commands with CRLF", async () => {
    const { client, sock } = makeClient();
    const connected = client.connect();
    sock.acceptBanner();
    await connected;
    expect(client.isConnected).toBe(true);

    await client.sendCommand("Play");
    expect(sock.txLines()).toEqual(["Play"]);
  });

  it("pipelines a batch of commands as a single TCP write", async () => {
    const { client, sock } = makeClient();
    const connected = client.connect();
    sock.acceptBanner();
    await connected;

    await client.sendPipeline(["ClearWorkingSong", "SetWorkingSongInfo url http://x", "QueueAndPlayOne working"]);
    // All three should be present in the same TX.
    expect(sock.txLines()).toEqual([
      "ClearWorkingSong",
      "SetWorkingSongInfo url http://x",
      "QueueAndPlayOne working",
    ]);
    // Single batched write — i.e. the client wrote them all at once.
    expect(sock.written.length).toBe(1);
  });
});

describe("RcpClient list parsing (real wire format)", () => {
  it("returns ListPresets entries, including empty slots", async () => {
    const { client, sock } = makeClient();
    const connected = client.connect();
    sock.acceptBanner();
    await connected;

    const promise = client.listPresets();
    sock.pushLine("ListPresets: ListResultSize 4");
    sock.pushLine("ListPresets: KQED 88.5 FM");
    sock.pushLine("ListPresets: WBUR 90.9 FM");
    sock.pushLine("ListPresets: ");
    sock.pushLine("ListPresets: BBC World Service");
    sock.pushLine("ListPresets: ListResultEnd");

    const presets = await promise;
    expect(presets).toEqual(["KQED 88.5 FM", "WBUR 90.9 FM", "", "BBC World Service"]);
  });

  it("ignores Transaction* status markers around a list response", async () => {
    const { client, sock } = makeClient();
    const connected = client.connect();
    sock.acceptBanner();
    await connected;

    const promise = client.listSongs();
    sock.pushLine("ListSongs: TransactionInitiated");
    sock.pushLine("ListSongs: ListResultSize 2");
    sock.pushLine("ListSongs: Track A");
    sock.pushLine("ListSongs: Track B");
    sock.pushLine("ListSongs: ListResultEnd");
    sock.pushLine("ListSongs: TransactionComplete");

    expect(await promise).toEqual(["Track A", "Track B"]);
  });

  it("the fix is essential: would NOT have parsed if we had keyed off command_key", async () => {
    // Regression guard: we look at the value, never the command name.
    const { client, sock } = makeClient();
    const connected = client.connect();
    sock.acceptBanner();
    await connected;

    const promise = client.listAlbums();
    // command_key here is "ListAlbums" — must NOT be confused with marker text
    sock.pushLine("ListAlbums: ListResultSize 1");
    sock.pushLine("ListAlbums: Greatest Hits");
    sock.pushLine("ListAlbums: ListResultEnd");

    expect(await promise).toEqual(["Greatest Hits"]);
  });
});

describe("RcpClient state updates from poll responses", () => {
  it("tracks power, transport, volume, and mute via push", async () => {
    const { client, sock } = makeClient();
    const connected = client.connect();
    sock.acceptBanner();
    await connected;

    // Push state lines as if the poll loop had asked for them.
    sock.pushLine("GetPowerState: on");
    sock.pushLine("GetTransportState: Play");
    sock.pushLine("GetVolume: 73");
    sock.pushLine("Mute: on");

    // A microtask boundary so the read loop has consumed the lines.
    await new Promise<void>((r) => setImmediate(r));

    expect(client.powerState).toBe("on");
    expect(client.transportState).toBe("play");
    expect(client.volume).toBe(73);
    expect(client.muted).toBe(true);
  });

  it("parses GetCurrentSongInfo title/artist/album", async () => {
    const { client, sock } = makeClient();
    const connected = client.connect();
    sock.acceptBanner();
    await connected;

    sock.pushLine("GetCurrentSongInfo: title: Athabasca");
    sock.pushLine("GetCurrentSongInfo: artist: matt pond PA");
    sock.pushLine("GetCurrentSongInfo: album: The Nature of Maps");
    sock.pushLine("GetCurrentSongInfo: OK");
    await new Promise<void>((r) => setImmediate(r));

    expect(client.title).toBe("Athabasca");
    expect(client.artist).toBe("matt pond PA");
    expect(client.album).toBe("The Nature of Maps");
  });
});

describe("RcpClient browse helpers", () => {
  it("setBrowseFilterAlbum sends the literal RCP command", async () => {
    const { client, sock } = makeClient();
    const connected = client.connect();
    sock.acceptBanner();
    await connected;

    await client.setBrowseFilterAlbum("Some Album");
    expect(sock.txLines().at(-1)).toBe("SetBrowseFilterAlbum Some Album");
  });

  it("playIndex sends PlayIndex N and assumes Play state", async () => {
    const { client, sock } = makeClient();
    const connected = client.connect();
    sock.acceptBanner();
    await connected;

    await client.playIndex(3);
    expect(sock.txLines().at(-1)).toBe("PlayIndex 3");
    expect(client.transportState).toBe("play");
  });

  it("connectServer sends ServerConnect", async () => {
    const { client, sock } = makeClient();
    const connected = client.connect();
    sock.acceptBanner();
    await connected;

    void client.connectServer(2);
    await new Promise<void>((r) => setImmediate(r));
    expect(sock.txLines().at(-1)).toBe("ServerConnect 2");
  });

  it("irDispatch wraps IrDispatchCommand <key>", async () => {
    const { client, sock } = makeClient();
    const connected = client.connect();
    sock.acceptBanner();
    await connected;

    await client.irDispatch("IR_KEY_UP");
    expect(sock.txLines().at(-1)).toBe("IrDispatchCommand IR_KEY_UP");
  });
});

describe("RcpClient change events", () => {
  it("emits 'change' when the device transitions to playing", async () => {
    const { client, sock } = makeClient();
    const cb = vi.fn();
    client.on("change", cb);
    const connected = client.connect();
    sock.acceptBanner();
    await connected;

    sock.pushLine("GetTransportState: Play");
    await new Promise<void>((r) => setImmediate(r));
    expect(cb).toHaveBeenCalled();
  });
});
