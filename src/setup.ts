/**
 * Driver setup flow.
 *
 * Single screen asks for SoundBridge host / port / friendly name. On
 * UserDataResponse: validate (best-effort RCP connect probe), persist
 * to disk, register the entity, return SetupComplete.
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

export interface SoundBridgeConfig {
  host: string;
  port: number;
  name: string;
}

export const ENTITY_ID = "soundbridge";

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
): (msg: SetupDriver) => Promise<SetupAction> {
  return async (msg: SetupDriver) => {
    if (msg instanceof DriverSetupRequest) return askForDeviceInfo(msg);
    if (msg instanceof UserDataResponse) {
      return finishSetup(configDir, msg, onConfigured);
    }
    return new SetupError();
  };
}

function askForDeviceInfo(_req: DriverSetupRequest): SetupAction {
  return new RequestUserInput({ en: "SoundBridge connection" }, [
    {
      id: "host",
      label: { en: "Hostname or IP" },
      field: { text: { value: "" } },
    },
    {
      id: "port",
      label: { en: "RCP port" },
      field: { number: { value: 5555, min: 1, max: 65535 } },
    },
    {
      id: "name",
      label: { en: "Friendly name" },
      field: { text: { value: "SoundBridge" } },
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
