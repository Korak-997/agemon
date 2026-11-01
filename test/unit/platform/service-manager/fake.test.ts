import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeServiceManager } from "../../../../src/platform/service-manager/fake.js";

const createdTempDirectories: string[] = [];

afterEach(async () => {
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

describe("fake service manager", () => {
  it("reads the environment of the unit it registered", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "agemon-fake-services-"));
    createdTempDirectories.push(homeDir);
    const serviceManager = createFakeServiceManager({ homeDir, user: "t" });
    expect(
      await serviceManager.readUnitEnvironment("agemon.service"),
    ).toBeNull();

    await serviceManager.registerAutostart({
      unitName: "agemon.service",
      attempts: [
        {
          label: "strict",
          unitContents:
            '[Service]\nEnvironment="GIT_NO_LAZY_FETCH=1"\nEnvironment="GIT_ALLOW_PROTOCOL="\n',
        },
      ],
    });

    expect(await serviceManager.readUnitEnvironment("agemon.service")).toEqual({
      GIT_NO_LAZY_FETCH: "1",
      GIT_ALLOW_PROTOCOL: "",
    });
  });
});
