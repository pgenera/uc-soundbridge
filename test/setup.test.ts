import { describe, it, expect, vi, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  DriverSetupRequest,
  RequestUserInput,
  SetupComplete,
  SetupError,
  UserDataResponse,
} from "@unfoldedcircle/integration-api";

import { firstStep, makeSetupHandler, type SoundBridgeConfig } from "../src/setup.js";
import type { DiscoveredSoundBridge } from "../src/discovery.js";

vi.mock("../src/rcp.js", () => ({
  RcpClient: class {
    connect = vi.fn(async () => {});
    disconnect = vi.fn(async () => {});
  },
}));

function rui(action: unknown): RequestUserInput {
  expect(action).toBeInstanceOf(RequestUserInput);
  return action as RequestUserInput;
}

const sb = (name: string, host: string, port = 5555): DiscoveredSoundBridge => ({
  name, host, port, addresses: [host],
});

describe("firstStep", () => {
  it("0 found → manual entry screen", () => {
    const a = rui(firstStep([]));
    expect(a.settings.map((s) => s.id)).toEqual(["host", "port", "name"]);
    const host = a.settings[0] as any;
    expect(host.field.text.value).toBe("");
  });

  it("1 found → confirm/edit pre-filled", () => {
    const a = rui(firstStep([sb("Living Room", "10.0.0.5", 5555)]));
    const host = a.settings.find((s) => s.id === "host") as any;
    const name = a.settings.find((s) => s.id === "name") as any;
    expect(host.field.text.value).toBe("10.0.0.5");
    expect(name.field.text.value).toBe("Living Room");
  });

  it("2+ found → dropdown with manual entry sentinel", () => {
    const a = rui(firstStep([sb("A", "10.0.0.5"), sb("B", "10.0.0.6")]));
    const dev = a.settings[0] as any;
    expect(dev.id).toBe("device");
    const ids = dev.field.dropdown.items.map((i: any) => i.id);
    expect(ids).toEqual(["idx:0", "idx:1", "__manual__"]);
  });
});

describe("makeSetupHandler", () => {
  let configDir: string;
  beforeEach(async () => {
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), "uc-setup-"));
  });

  it("auto-pick path: discover→confirm→save", async () => {
    const onConfigured = vi.fn(async () => {});
    const handle = makeSetupHandler(configDir, onConfigured, async () => [
      sb("Kitchen", "192.168.1.7", 5555),
    ]);

    const step1 = rui(await handle(new DriverSetupRequest(false, {})));
    const host = step1.settings.find((s) => s.id === "host") as any;
    expect(host.field.text.value).toBe("192.168.1.7");

    const done = await handle(new UserDataResponse({ host: "192.168.1.7", port: "5555", name: "Kitchen" }));
    expect(done).toBeInstanceOf(SetupComplete);
    expect(onConfigured).toHaveBeenCalledOnce();
    const written = JSON.parse(await fs.readFile(path.join(configDir, "config.json"), "utf8")) as SoundBridgeConfig;
    expect(written).toEqual({ host: "192.168.1.7", port: 5555, name: "Kitchen" });
  });

  it("pick path: dropdown→confirm→save", async () => {
    const handle = makeSetupHandler(configDir, async () => {}, async () => [
      sb("A", "10.0.0.5"),
      sb("B", "10.0.0.6"),
    ]);

    rui(await handle(new DriverSetupRequest(false, {})));
    const step2 = rui(await handle(new UserDataResponse({ device: "idx:1" })));
    const host = step2.settings.find((s) => s.id === "host") as any;
    expect(host.field.text.value).toBe("10.0.0.6");

    const done = await handle(new UserDataResponse({ host: "10.0.0.6", port: "5555", name: "B" }));
    expect(done).toBeInstanceOf(SetupComplete);
  });

  it("manual sentinel → blank manual screen", async () => {
    const handle = makeSetupHandler(configDir, async () => {}, async () => [
      sb("A", "10.0.0.5"),
      sb("B", "10.0.0.6"),
    ]);
    rui(await handle(new DriverSetupRequest(false, {})));
    const step2 = rui(await handle(new UserDataResponse({ device: "__manual__" })));
    const host = step2.settings.find((s) => s.id === "host") as any;
    expect(host.field.text.value).toBe("");
  });

  it("invalid dropdown index → SetupError", async () => {
    const handle = makeSetupHandler(configDir, async () => {}, async () => [sb("A", "10.0.0.5")]);
    rui(await handle(new DriverSetupRequest(false, {})));
    const r = await handle(new UserDataResponse({ device: "idx:99" }));
    expect(r).toBeInstanceOf(SetupError);
  });

  it("empty host → SetupError", async () => {
    const handle = makeSetupHandler(configDir, async () => {}, async () => []);
    rui(await handle(new DriverSetupRequest(false, {})));
    const r = await handle(new UserDataResponse({ host: "", port: "5555", name: "x" }));
    expect(r).toBeInstanceOf(SetupError);
  });
});
