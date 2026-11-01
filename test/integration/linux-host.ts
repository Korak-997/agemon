import type * as InstallLocation from "../../src/core/install-location.js";
import type * as Detect from "../../src/platform/detect.js";

export const LINUX_HOST = { hostPlatform: "linux", hostArch: "x64" } as const;

export async function mockDetectOnLinuxHost(
  importOriginal: () => Promise<typeof Detect>,
): Promise<typeof Detect> {
  const actual = await importOriginal();
  return {
    ...actual,
    detectPlatformCapabilities: (input) =>
      actual.detectPlatformCapabilities({ ...LINUX_HOST, ...input }),
  };
}

export async function mockInstallLocationOnLinuxHost(
  importOriginal: () => Promise<typeof InstallLocation>,
): Promise<typeof InstallLocation> {
  const actual = await importOriginal();
  return {
    ...actual,
    assertNotRootOnMacOS: (hostPlatform = LINUX_HOST.hostPlatform, uid) =>
      actual.assertNotRootOnMacOS(hostPlatform, uid),
  };
}
