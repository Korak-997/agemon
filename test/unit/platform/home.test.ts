import { realpath } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

const userInfoMock = vi.hoisted(() => vi.fn());

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  userInfo: userInfoMock,
}));

const { containsHomeDirectory, isHomeDirectory, resolveHomeDirectory } =
  await import("../../../src/platform/home.js");

afterEach(() => {
  vi.unstubAllEnvs();
  userInfoMock.mockReset();
});

describe("resolveHomeDirectory", () => {
  it.each([
    ["empty", ""],
    ["relative", "relative-home"],
  ])("uses the account's home when HOME is %s", (_label, home) => {
    vi.stubEnv("HOME", home);
    userInfoMock.mockReturnValue({ homedir: "/home/account" });

    expect(resolveHomeDirectory()).toBe("/home/account");
  });
});

describe("resolveHomeDirectory without a usable home", () => {
  it("refuses instead of returning the rejected HOME", () => {
    vi.stubEnv("HOME", "relative-home");
    userInfoMock.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory, uv_os_get_passwd");
    });

    expect(() => resolveHomeDirectory()).toThrow(/Set HOME/);
  });
});

describe("isHomeDirectory", () => {
  it("still answers from HOME when the account has no passwd entry", async () => {
    vi.stubEnv("HOME", "/");
    userInfoMock.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory, uv_os_get_passwd");
    });

    expect(await isHomeDirectory("/")).toBe(true);
    expect(await isHomeDirectory("/tmp")).toBe(false);
  });
});

describe("containsHomeDirectory", () => {
  it("is true for the home directory itself and any directory above it", async () => {
    vi.stubEnv("HOME", "/tmp");
    userInfoMock.mockReturnValue({ homedir: "/nonexistent-account-home" });

    expect(await containsHomeDirectory(await realpath("/tmp"))).toBe(true);
    expect(await containsHomeDirectory("/")).toBe(true);
    expect(await containsHomeDirectory("/usr")).toBe(false);
  });
});
