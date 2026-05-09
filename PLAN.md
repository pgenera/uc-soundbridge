# uc-soundbridge — design plan

Unfolded Circle Remote Two/3 integration driver for the Roku SoundBridge,
exposing the device as a single MediaPlayer entity with full IR-remote
parity (transport, volume, dpad/menu/numpad) plus the categorical media
browser we built for the Home Assistant component (presets + library
servers → albums/artists/genres/playlists → tracks).

## Scope (decided)

| Question | Choice |
| --- | --- |
| Multi-device support | One device per integration instance. Multiple SoundBridges = multiple containers. |
| IR coverage | Full IR remote parity. dpad, home, menu, back, info, numpad routed via RCP `IrDispatchCommand`. |
| Features (v1) | OnOff, PlayPause, Stop, Next, Previous, Volume, VolumeUpDown, Mute/Unmute/MuteToggle, BrowseMedia, PlayMedia, Dpad, Numpad, Home, Menu, Back, Info, MediaTitle/Artist/Album/Duration/Position. |
| Out of scope (v1) | Shuffle, Repeat (RCP supports them; trivial follow-up). Search. UPnP folder tree. |
| Test runner | Vitest. |
| Node toolchain | Docker `node:22`. No host install. |

## Layout

```
uc-soundbridge/
├── package.json           "@unfoldedcircle/integration-api" ^0.5, vitest, typescript
├── tsconfig.json          ESM, NodeNext, strict
├── vitest.config.ts
├── driver.json            driver_id, version, port 9080, name, etc.
├── Dockerfile             multi-stage: node:22 build → node:22-slim runtime
├── README.md
├── PLAN.md                this file
├── src/
│   ├── rcp.ts             RCP wire client (port 5555 + sketch on 4444 if needed)
│   ├── ir.ts              UC-command → IR-key mapping for IrDispatchCommand
│   ├── browser.ts         browse_media tree builder + media_id path encoding
│   ├── player.ts          SoundBridgeMediaPlayer (extends MediaPlayer)
│   ├── setup.ts           driver setup flow (asks for host)
│   └── driver.ts          main entry; constructs IntegrationAPI + entity
└── test/
    ├── rcp.test.ts        socket mocking, list-result parsing, framing
    ├── browser.test.ts    path encode/decode round-trip, tree shape
    └── player.test.ts     command dispatch, browse() output, attribute mapping
```

## RCP client (`src/rcp.ts`)

Direct port of the HA `protocol.py` after the parser fix. Key elements:

- `connect()`: `net.createConnection({host, port: 5555})`, read banner
  (`roku: ready`), then start poll + read loops.
- Single FIFO of pending response promises, keyed by command name.
  `sendCommand(cmd, {waitForResponse?})` returns a promise resolved by
  `_readLoop` when the matching reply line arrives.
- List-result parsing: detect markers in the **value** half of the line
  (`<Cmd>: ListResultSize N`, `<Cmd>: ListResultEnd`), ignore
  Transaction* status markers, append in-list lines as items.
- Poll loop: every 5s when on, 10s in standby. Keeps `state`,
  `transportState`, `volume`, `mute`, `title/artist/album`, `position`,
  `duration` up-to-date; emits `change` events.
- Browse helpers: `listPresets()`, `listServers()`, `listAlbums()`,
  `listArtists()`, `listGenres()`, `listPlaylists()`,
  `listPlaylistSongs(idx)`, `listSongs()`, plus `connectServer(idx)` /
  `setBrowseFilter*` / `playIndex(n)`.
- IR helper: `irDispatch(key)` → `IrDispatchCommand <key>`.
- Reconnect with exponential backoff on socket loss.

## Browse path scheme (`src/browser.ts`)

Identical to the HA component's `media_content_id` scheme so test
expectations transfer:

```
""                                       implicit root (when browse() called with no media_id)
presets                                  18-slot preset list (empty/Preset NN filtered)
servers                                  list of music servers
servers/<i>                              category menu for server i
servers/<i>/<cat>                        items in category (albums|artists|genres|playlists|songs)
servers/<i>/<cat>/<urlencoded-name>      tracks under that filter (or just track index for songs)
servers/<i>/<cat>/<urlencoded-name>/<n>  playable leaf — play track index n
play_preset:<n>                          playable leaf — play preset n (0..17)
```

Path segments containing `/`, `:`, etc. are URL-encoded; decoded back
when handling clicks. `_parseServerPath()` mirrors the HA helper.

## MediaPlayer (`src/player.ts`)

Subclass `uc.MediaPlayer`. Constructor builds `features` array based on
the scope above, attributes seeded from RCP state.

`async command(cmdId, params)` switch:

| UC command | RCP action |
| --- | --- |
| `on` / `off` / `toggle` | `PlayPreset 0` / `SetPowerState standby` / probe + flip |
| `play_pause` | `PlayPause` (or Play / Pause based on current state) |
| `stop` | `Stop` |
| `previous` / `next` | `Previous` / `Next` |
| `volume` | `SetVolume <n>` |
| `volume_up` / `volume_down` | `SetVolume current ± step` |
| `mute` / `unmute` / `mute_toggle` | `Mute on` / `Mute off` / based on state |
| `cursor_up/down/left/right/enter` | `IrDispatchCommand IR_KEY_UP/...` |
| `digit_0..9` | `IrDispatchCommand IR_KEY_0..9` |
| `home` / `menu` / `back` / `info` | `IrDispatchCommand IR_KEY_HOME/...` |
| `play_media` (`media_id` = `play_preset:N`) | `PlayPreset N` |
| `play_media` (`media_id` = `servers/...`) | connectServer → setBrowseFilter → list → PlayIndex |

`async browse(options)` mirrors the HA `_async_browse_*` family using
`BrowseMediaItem` / `BrowseResult.fromPaging()`. Pagination honoured at
each level (slice the list before wrapping in BrowseResult).

State sync: subscribe to RCP-client `change` events; whenever state
updates, push attribute changes via `this.attributes` setter so UC
gets `entity_change` events.

## Driver bootstrap (`src/driver.ts`)

```ts
const api = new uc.IntegrationAPI();
api.init("driver.json", driverSetupHandler);
api.on(uc.Events.Connect, async () => api.setDeviceState(uc.DeviceStates.Connected));
api.on(uc.Events.SubscribeEntities, ...);  // start RCP if not already
```

Persisted setup data (host, port, friendly name) lives in `config.json`
under `UC_CONFIG_HOME`. On startup, if config exists, instantiate the
RCP client + entity immediately. Otherwise wait for the setup flow.

## Setup flow (`src/setup.ts`)

Single screen: ask for host (text input) and friendly name. Optional
port (default 5555). On `DriverSetupRequest`: present the form. On
`UserDataResponse`: validate, persist to config, register a single
`SoundBridgeMediaPlayer` entity, return `SetupComplete`.
Reconfigure path replaces the existing entity.

## Lifecycle

- Container starts → `IntegrationAPI` listens on port 9080.
- Remote discovers via mDNS (`_uc-integration._tcp` advertised by the
  wrapper).
- First connection: if no config, setup flow runs; else the entity is
  already available.
- On Subscribe: ensure RCP socket is connected, push current state.
- On `entity_command`: dispatch via the table above.
- On `EnterStandby` / `ExitStandby`: pause / resume polling (keep RCP
  socket alive).

## Testing strategy

**rcp.test.ts** — instantiate `RcpClient` with a mocked `net.Socket`
(EventEmitter that records writes and lets the test push fake server
lines). Cover:
- Banner handshake.
- Command write framing.
- List parsing for the real wire format (`Cmd: ListResultSize N` /
  items / `Cmd: ListResultEnd`), including empty-string items and
  transaction markers.
- Power, volume, transport state updates from poll responses.
- Reconnect on socket close.

**browser.test.ts** — pure unit tests on path encode/decode and the
`_parseServerPath` helper. Covers all 5 categories, special chars,
malformed paths.

**player.test.ts** — subclass instantiated with a mock RCP client.
- `browse({})` → root with Presets + Servers.
- `browse({media_id: "presets"})` → 18 → filtered list (10 valid).
- `browse({media_id: "servers/0/albums/Some%20Album"})` → songs
  re-list with album filter applied.
- `command("play_pause")` → calls correct RCP method.
- `command("cursor_up")` → IrDispatchCommand IR_KEY_UP.
- `command("play_media", {media_id: "servers/0/albums/X/3"})` →
  connectServer(0) + setBrowseFilterAlbum("X") + listSongs() +
  playIndex(3).

## Smoke test

After tests pass: `docker run` the runtime image with `--network host`,
configure via the wrapper's setup endpoint or by hand-writing
`config.json`, then verify with the live SoundBridge by:
1. Opening a WS client to `ws://localhost:9080`.
2. Sending `get_available_entities`.
3. Calling `browse_media` with `media_id: "presets"` and asserting the
   real preset names come back.

## Docker image

Multi-stage:

```dockerfile
FROM node:22 AS build
WORKDIR /app
COPY package*.json tsconfig.json driver.json ./
COPY src ./src
RUN npm ci && npm run build

FROM node:22-slim
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/driver.json ./
COPY --from=build /app/node_modules ./node_modules
ENV UC_CONFIG_HOME=/data
EXPOSE 9080
CMD ["node", "dist/driver.js"]
```

Run with:

```sh
docker run -d --network host -v uc-soundbridge-data:/data \
    --name uc-soundbridge ghcr.io/pgenera/uc-soundbridge:dev
```

`--network host` so mDNS announcements work without bridge tricks.
