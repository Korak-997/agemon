import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CORE_CAPABILITY_IDS,
  getRegisteredPlugins,
} from "../../../src/plugins/index.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("plugin registry", () => {
  it.each(["1", ""])(
    "is the capability registry when AGEMON_DEV is %j",
    (agemonDev) => {
      vi.stubEnv("AGEMON_DEV", agemonDev);

      expect(getRegisteredPlugins().map((plugin) => plugin.id)).toEqual(
        CORE_CAPABILITY_IDS,
      );
    },
  );

  it("agents, master-prompt and skills expose no install that would skip consent", () => {
    const pluginsById = new Map(
      getRegisteredPlugins().map((plugin) => [plugin.id, plugin] as const),
    );

    for (const id of ["agents", "master-prompt", "skills"]) {
      expect(pluginsById.get(id)?.install).toBeUndefined();
    }
  });

  it("every registered capability can be applied", () => {
    for (const plugin of getRegisteredPlugins()) {
      expect(plugin.apply ?? plugin.install).toBeTypeOf("function");
    }
  });
});
