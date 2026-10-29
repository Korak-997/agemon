import { afterEach, describe, expect, it, vi } from "vitest";
import { createServiceManager } from "../../../src/platform/service-manager/index.js";
import { createUnavailableServiceManager } from "../../../src/platform/service-manager/unavailable.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

const UNIT_NAME = "agemon-crg-repo-0123abcd.service";

const serviceManager = createUnavailableServiceManager({
  unitPathFor: (unitName) => `/home/user/.config/systemd/user/${unitName}`,
  readUnitWorkingDirectory: async () => "/home/user/repo",
  findAgemonDaemonUnit: async () => UNIT_NAME,
});

describe("createUnavailableServiceManager", () => {
  it("answers read paths without systemd", async () => {
    expect(await serviceManager.isActive(UNIT_NAME)).toEqual({
      active: false,
    });
    expect(await serviceManager.readUnitWorkingDirectory(UNIT_NAME)).toBe(
      "/home/user/repo",
    );
    expect(await serviceManager.findAgemonDaemonUnit()).toBe(UNIT_NAME);
  });

  it("refuses to remove a unit, naming its path and the way out", async () => {
    await expect(
      serviceManager.unregisterAutostart({ unitName: UNIT_NAME }),
    ).rejects.toThrow(
      `systemd is not running on this machine; remove /home/user/.config/systemd/user/${UNIT_NAME} by hand, or run 'agemon nuke' where systemd runs.`,
    );
  });

  it("refuses to register a unit or touch linger", async () => {
    await expect(
      serviceManager.registerAutostart({ unitName: UNIT_NAME, attempts: [] }),
    ).rejects.toThrow("systemd is not running on this machine");
    await expect(serviceManager.isLingerEnabled()).rejects.toThrow(
      "cannot manage user linger",
    );
    await expect(serviceManager.enableLinger()).rejects.toThrow(
      "cannot manage user linger",
    );
    await expect(serviceManager.disableLinger()).rejects.toThrow(
      "cannot manage user linger",
    );
  });

  it("is what createServiceManager returns without systemd, even with no user name set", async () => {
    vi.stubEnv("AGEMON_FAKE_SERVICES", "");
    vi.stubEnv("USER", "");
    vi.stubEnv("LOGNAME", "");
    vi.stubEnv("USERNAME", "");

    const manager = createServiceManager({
      kind: "none",
      run: async () => ({ code: 0, stdout: "", stderr: "" }),
    });

    expect(await manager.isActive(UNIT_NAME)).toEqual({ active: false });
    await expect(
      manager.unregisterAutostart({ unitName: UNIT_NAME }),
    ).rejects.toThrow("systemd is not running on this machine");
  });
});
