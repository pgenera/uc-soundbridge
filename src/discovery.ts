/**
 * mDNS discovery for Roku SoundBridge devices.
 *
 * SoundBridges advertise `_roku-rcp._tcp` (port 5555 by default). The
 * service instance name is the device's friendly name (e.g. "Living Room").
 */

import { createRequire } from "node:module";
import type { Bonjour as BonjourType, Service } from "bonjour-service";

// bonjour-service is CommonJS with `__esModule: true` and both
// `exports.default` and `exports.Bonjour` set to the same class. Node's
// ESM-from-CJS interop is inconsistent here:
//   - `import { Bonjour }` throws at runtime on the Remote (v0.3.7).
//   - `import Bonjour` trips TS NodeNext because the package's type
//     defs export Bonjour as a named class but Node returns the class
//     as the default (v0.3.9).
// Use `createRequire` to load the CJS module directly and bypass interop.
const require = createRequire(import.meta.url);
const { Bonjour } = require("bonjour-service") as { Bonjour: new () => BonjourType };

export interface DiscoveredSoundBridge {
  name: string;
  host: string;
  port: number;
  addresses: string[];
}

function pickAddress(svc: Service): string | null {
  const addrs = svc.addresses ?? [];
  const ipv4 = addrs.find((a) => a.includes(".") && !a.startsWith("127."));
  if (ipv4) return ipv4;
  const ipv6 = addrs.find((a) => a.includes(":") && !a.startsWith("::1"));
  return ipv6 ?? svc.host ?? null;
}

export async function discoverSoundBridges(timeoutMs = 4000): Promise<DiscoveredSoundBridge[]> {
  const bj = new Bonjour();
  const found = new Map<string, DiscoveredSoundBridge>();

  return new Promise((resolve) => {
    const browser = bj.find({ type: "roku-rcp", protocol: "tcp" }, (svc: Service) => {
      const host = pickAddress(svc);
      if (!host) return;
      const key = `${host}:${svc.port}`;
      if (found.has(key)) return;
      found.set(key, {
        name: svc.name,
        host,
        port: svc.port,
        addresses: (svc.addresses ?? []).filter((a) => a.includes(".") && !a.startsWith("127.")),
      });
    });

    setTimeout(() => {
      try { browser.stop(); } catch { /* noop */ }
      try { bj.destroy(); } catch { /* noop */ }
      resolve([...found.values()]);
    }, timeoutMs);
  });
}
