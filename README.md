# uc-soundbridge

Unfolded Circle Remote Two/3 integration driver for the Roku SoundBridge.

Exposes the SoundBridge as a single MediaPlayer entity with:

- **Transport** — play/pause, stop, next/previous
- **Volume** — set / step / mute / unmute / toggle
- **Power** — on / off / toggle (via `PlayPreset 0` / `SetPowerState standby`)
- **Full IR remote parity** — dpad, home, menu, back, info, numpad — routed
  through RCP `IrDispatchCommand`, so the UC remote can drive the device's
  native UI button-for-button.
- **Categorical media browser** — Presets and Library Servers → Albums /
  Artists / Genres / Playlists / All Songs → tracks. Empty preset slots
  (and the literal `Preset NN` placeholder some firmware returns) are
  hidden.
- **Play media** — by preset (`play_preset:N`) or library track
  (`servers/<i>/<category>/<name>/<index>`).

The browse path scheme is identical to the Home Assistant component's,
which makes behaviour and tests interchangeable.

## Run

```sh
docker build -t uc-soundbridge:0.1.0 .

docker run -d --restart=unless-stopped \
    --name uc-soundbridge \
    --network host \
    -v uc-soundbridge-data:/data \
    uc-soundbridge:0.1.0
```

`--network host` is recommended so mDNS announcements work without
bridge tricks. Setup happens via the UC remote's integration setup
flow (asks for hostname, port, friendly name) and persists to
`/data/config.json`.

## Develop

```sh
# Install dependencies (one-off)
docker run --rm -v "$PWD":/app -w /app node:22 npm install

# Run tests
docker run --rm -v "$PWD":/app -w /app node:22 npx vitest run

# Type-check
docker run --rm -v "$PWD":/app -w /app node:22 npx tsc --noEmit

# Build
docker run --rm -v "$PWD":/app -w /app node:22 npm run build
```

## Layout

See `PLAN.md` for the full design. In short:

```
src/
  rcp.ts       RCP wire client (port 5555). Port of HA protocol.py.
  browser.ts   browse-tree path scheme (encode/decode + ServerNav).
  ir.ts        UC command -> SoundBridge IR key mapping.
  player.ts    SoundBridgeMediaPlayer entity (commands + browse).
  setup.ts     Driver setup flow (asks for host/port/name).
  driver.ts    Entry point — wires it all together.
test/
  rcp.test.ts       List parsing, framing, state updates, change events.
  browser.test.ts   Path encode/decode, ServerNav parsing, preset filter.
  player.test.ts    Browse output, command dispatch, attribute mapping.
```
