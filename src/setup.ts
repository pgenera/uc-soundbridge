/**
 * Driver setup flow.
 *
 * State machine:
 *   1. DriverSetupRequest → mDNS discovery (~4s).
 *      - 1 found: skip to confirm/edit screen with values pre-filled.
 *      - 0 found: manual-entry screen (with a notice).
 *      - 2+ found: dropdown of discovered devices + "Manual entry…".
 *   2. UserDataResponse with `device`:
 *      - "manual" sentinel → manual-entry screen.
 *      - "idx:N" → confirm/edit screen with that device's values.
 *   3. UserDataResponse with `host` → probe, persist, register, complete.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import {
  api as ucApi,
  DriverSetupRequest,
  RequestUserInput,
  SetupComplete,
  SetupError,
  UserDataResponse,
  type SetupAction,
  type SetupDriver,
} from "@unfoldedcircle/integration-api";

import { RcpClient } from "./rcp.js";
import { discoverSoundBridges, type DiscoveredSoundBridge } from "./discovery.js";

export interface SoundBridgeConfig {
  host: string;
  port: number;
  name: string;
}

export const ENTITY_ID = "soundbridge";
const MANUAL_ID = "__manual__";

export function configPath(configDir: string): string {
  return path.join(configDir, "config.json");
}

export async function loadConfig(configDir: string): Promise<SoundBridgeConfig | null> {
  try {
    const raw = await fs.readFile(configPath(configDir), "utf8");
    const data = JSON.parse(raw) as Partial<SoundBridgeConfig>;
    if (!data.host) return null;
    return {
      host: data.host,
      port: typeof data.port === "number" ? data.port : 5555,
      name: data.name && data.name.trim().length > 0 ? data.name : "SoundBridge",
    };
  } catch {
    return null;
  }
}

export async function saveConfig(configDir: string, config: SoundBridgeConfig): Promise<void> {
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(configPath(configDir), JSON.stringify(config, null, 2));
}

export function makeSetupHandler(
  configDir: string,
  onConfigured: (config: SoundBridgeConfig) => Promise<void>,
  discover: () => Promise<DiscoveredSoundBridge[]> = () => discoverSoundBridges(),
): (msg: SetupDriver) => Promise<SetupAction> {
  // Captured between steps within a single setup session. The wrapper
  // serializes setup, so a module-level cache is sufficient.
  let lastDiscovered: DiscoveredSoundBridge[] = [];

  return async (msg: SetupDriver) => {
    if (msg instanceof DriverSetupRequest) {
      lastDiscovered = await discover();
      return firstStep(lastDiscovered);
    }
    if (msg instanceof UserDataResponse) {
      const inputs = msg.inputValues;
      if (inputs.device !== undefined) {
        if (inputs.device === MANUAL_ID) {
          return askForDeviceInfo("", 5555, "SoundBridge", { en: "Manual entry" });
        }
        const m = /^idx:(\d+)$/.exec(inputs.device);
        if (m) {
          const i = Number(m[1]);
          const d = lastDiscovered[i];
          if (d) {
            return askForDeviceInfo(d.host, d.port, d.name, { en: "Confirm SoundBridge" });
          }
        }
        return new SetupError(ucApi.IntegrationSetupError.Other);
      }
      return finishSetup(configDir, msg, onConfigured);
    }
    return new SetupError();
  };
}

export function firstStep(found: DiscoveredSoundBridge[]): SetupAction {
  if (found.length === 1 && found[0]) {
    const d = found[0];
    return askForDeviceInfo(d.host, d.port, d.name, { en: "Found a SoundBridge — confirm" });
  }
  if (found.length === 0) {
    return askForDeviceInfo("", 5555, "SoundBridge", { en: "No SoundBridges found — enter manually" });
  }
  return askPickDevice(found);
}

function askPickDevice(found: DiscoveredSoundBridge[]): SetupAction {
  const items: Array<{ id: string; label: { en: string } }> = found.map((d, i) => ({
    id: `idx:${i}`,
    label: { en: `${d.name} (${d.host})` },
  }));
  items.push({ id: MANUAL_ID, label: { en: "Manual entry…" } });

  const defaultId = items[0]?.id ?? MANUAL_ID;
  return new RequestUserInput({ en: "Select your SoundBridge" }, [
    {
      id: "device",
      label: { en: "Discovered devices" },
      field: { dropdown: { value: defaultId, items } },
    },
  ]);
}

function askForDeviceInfo(
  host: string,
  port: number,
  name: string,
  title: { en: string },
): SetupAction {
  return new RequestUserInput(title, [
    {
      id: "host",
      label: { en: "Hostname or IP" },
      field: { text: { value: host } },
    },
    {
      id: "port",
      label: { en: "RCP port" },
      field: { number: { value: port, min: 1, max: 65535 } },
    },
    {
      id: "name",
      label: { en: "Friendly name" },
      field: { text: { value: name } },
    },
  ]);
}

async function finishSetup(
  configDir: string,
  msg: UserDataResponse,
  onConfigured: (config: SoundBridgeConfig) => Promise<void>,
): Promise<SetupAction> {
  const host = (msg.inputValues.host ?? "").trim();
  if (!host) {
    return new SetupError(ucApi.IntegrationSetupError.Other);
  }
  const port = Number.parseInt(msg.inputValues.port ?? "5555", 10) || 5555;
  const name = (msg.inputValues.name || "SoundBridge").trim() || "SoundBridge";
  const config: SoundBridgeConfig = { host, port, name };

  // Probe the device. We don't fail setup if probing fails — the user
  // may want to set up while the device is offline — but we attempt to
  // surface obvious connection problems.
  try {
    const probe = new RcpClient({ ...config, poll: false });
    await probe.connect();
    await probe.disconnect();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("RCP probe failed during setup:", err);
  }

  await saveConfig(configDir, config);
  await onConfigured(config);
  return new SetupComplete();
}
