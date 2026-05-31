/**
 * Integration driver entry point.
 *
 * Constructs the IntegrationAPI, loads (or runs setup for) the
 * SoundBridge config, registers a single SoundBridgeMediaPlayer, and
 * keeps the RCP socket connected for the lifetime of the process.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DeviceStates,
  Events as UcEvents,
  IntegrationAPI,
} from "@unfoldedcircle/integration-api";

import { RcpClient } from "./rcp.js";
import { SoundBridgeMediaPlayer } from "./player.js";
import { loadConfig, makeSetupHandler, ENTITY_ID, type SoundBridgeConfig } from "./setup.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// On the UC Remote, the installer flattens bin/ into /app, so driver.json
// sits beside driver.js. In local dev the compiled output lives in dist/
// while driver.json stays at the repo root one level up. Pick whichever
// exists.
const driverJsonSibling = path.join(__dirname, "driver.json");
const driverJsonParent = path.join(__dirname, "..", "driver.json");
const driverJson = existsSync(driverJsonSibling) ? driverJsonSibling : driverJsonParent;

const api = new IntegrationAPI();
let client: RcpClient | null = null;
let player: SoundBridgeMediaPlayer | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectAttempt = 0;

const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;

function scheduleReconnect(target: RcpClient): void {
  if (reconnectTimer) return;
  const delay = Math.min(
    RECONNECT_MAX_MS,
    RECONNECT_MIN_MS * 2 ** Math.min(reconnectAttempt, 5),
  );
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (client !== target) return; // config swapped under us
    target.connect().catch((err) => {
      // eslint-disable-next-line no-console
      console.warn(
        `RCP reconnect attempt ${reconnectAttempt} failed: ${(err as Error).message}`,
      );
      scheduleReconnect(target);
    });
  }, delay);
  reconnectTimer.unref?.();
}

async function attachConfig(config: SoundBridgeConfig): Promise<void> {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempt = 0;

  if (player) {
    player.detach();
    player = null;
  }
  if (client) {
    await client.disconnect();
    client = null;
  }

  const newClient = new RcpClient({ host: config.host, port: config.port, poll: true });
  client = newClient;
  player = new SoundBridgeMediaPlayer(ENTITY_ID, config.name, newClient, api);

  // Swallow socket errors; the close/connect-failure paths drive reconnect.
  newClient.on("error", (err: Error) => {
    // eslint-disable-next-line no-console
    console.warn(`RCP socket error: ${err.message}`);
  });
  newClient.on("connect", () => {
    reconnectAttempt = 0;
  });
  newClient.on("disconnect", () => scheduleReconnect(newClient));

  api.clearAvailableEntities();
  api.addAvailableEntity(player);

  newClient.connect().catch((err) => {
    // eslint-disable-next-line no-console
    console.warn(`Initial RCP connect failed: ${(err as Error).message}`);
    scheduleReconnect(newClient);
  });
}

const configDir = api.getConfigDirPath();

api.init(driverJson, makeSetupHandler(configDir, attachConfig));

api.on(UcEvents.Connect, async () => {
  await api.setDeviceState(DeviceStates.Connected);
});

api.on(UcEvents.Disconnect, async () => {
  await api.setDeviceState(DeviceStates.Disconnected);
});

// On startup, if we already have a config persisted, instantiate the
// entity right away so it's available before the remote connects.
void (async () => {
  const config = await loadConfig(configDir);
  if (config) await attachConfig(config);
})();
