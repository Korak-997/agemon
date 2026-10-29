import type { PlatformCapabilities } from "../../src/platform/detect.js";

export const LINUX_TEST_PLATFORM: PlatformCapabilities = {
  family: "linux",
  arch: "x64",
  serviceManager: "systemd-user",
  unsupportedReason: null,
};
