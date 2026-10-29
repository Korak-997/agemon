import { describe, expect, it } from "vitest";
import { assertNotRootOnMacOS } from "../../../src/core/install-location.js";

describe("assertNotRootOnMacOS", () => {
  it("refuses root on darwin with the way out", () => {
    expect(() => assertNotRootOnMacOS("darwin", 0)).toThrow(
      "On macOS agemon runs as your own user, never as root",
    );
    expect(() => assertNotRootOnMacOS("darwin", 0)).toThrow(
      "sudo npm uninstall -g agemon",
    );
  });

  it("allows a normal user on darwin and root on linux", () => {
    expect(() => assertNotRootOnMacOS("darwin", 501)).not.toThrow();
    expect(() => assertNotRootOnMacOS("linux", 0)).not.toThrow();
  });
});
