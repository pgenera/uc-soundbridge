/**
 * Integration driver entry point.
 *
 * Constructs the IntegrationAPI, loads (or runs setup for) the
 * SoundBridge config, registers a single SoundBridgeMediaPlayer, and
 * keeps the RCP socket connected for the lifetime of the process.
 */

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
const driverJson = path.join(__dirname, "..", "driver.json");

const api = new IntegrationAPI();
let client: RcpClient | null = null;
let player: SoundBridgeMediaPlayer | null = null;

async function attachConfig(config: SoundBridgeConfig): Promise<void> {
  if (player) {
    player.detach();
    player = null;
  }
  if (client) {
    await client.disconnect();
    client = null;
  }

  client = new RcpClient({ host: config.host, port: config.port, poll: true });
  player = new SoundBridgeMediaPlayer(ENTITY_ID, config.name, client, api);

  api.clearAvailableEntities();
  api.addAvailableEntity(player);

  // Kick off the connection in the background; reconnects happen
  // automatically inside the RCP client.
  client.connect().catch((err) => {
    // eslint-disable-next-line no-console
    console.warn("Initial RCP connect failed; will retry:", err);
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
