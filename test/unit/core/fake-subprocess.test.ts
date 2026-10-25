import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFakeVerifiedBinaryInstaller,
  fakeCodeReviewGraphOnPath,
  resetFakeSubprocessState,
  runFakeSubprocess,
  takeFakeVerifiedBinaryInstallRequests,
} from "../../../src/core/fake-subprocess.js";
import {
  AGNIX_VERSION,
  CODE_REVIEW_GRAPH_VERSION,
  ESSENTIALS_SKILLS_COMMIT,
} from "../../../src/plugins/pins.js";

const PINNED_SKILLS_CLI =
  "/state/agemon/tools/0123456789abcdef/node_modules/skills/bin/cli.mjs";
const PINNED_CRG_SPEC = `code-review-graph==${CODE_REVIEW_GRAPH_VERSION}`;

function isJsonList(stdout: string): boolean {
  try {
    return Array.isArray(JSON.parse(stdout));
  } catch {
    return false;
  }
}

beforeEach(() => {
  resetFakeSubprocessState();
});

describe("runFakeSubprocess", () => {
  it("answers skills calls only through the pinned CLI path", () => {
    const pinned = runFakeSubprocess(process.execPath, [
      PINNED_SKILLS_CLI,
      "list",
      "--json",
    ]);
    const unpinned = runFakeSubprocess("npx", ["skills", "list", "--json"]);

    expect(isJsonList(pinned.stdout)).toBe(true);
    expect(isJsonList(unpinned.stdout)).toBe(false);
  });

  it("tracks skills added and removed through the pinned CLI", () => {
    runFakeSubprocess(process.execPath, [
      PINNED_SKILLS_CLI,
      "add",
      "/src/skills/writing-guidelines",
      "--skill",
      "writing-guidelines",
    ]);
    const afterAdd = runFakeSubprocess(process.execPath, [
      PINNED_SKILLS_CLI,
      "list",
      "--json",
    ]);
    runFakeSubprocess(process.execPath, [
      PINNED_SKILLS_CLI,
      "remove",
      "writing-guidelines",
      "--yes",
    ]);
    const afterRemove = runFakeSubprocess(process.execPath, [
      PINNED_SKILLS_CLI,
      "list",
      "--json",
    ]);

    expect(JSON.parse(afterAdd.stdout)).toMatchObject([
      { name: "writing-guidelines" },
    ]);
    expect(JSON.parse(afterRemove.stdout)).toEqual([]);
  });

  it("installs code-review-graph only at the pinned version, under the fake pipx home", async () => {
    const home = await mkdtemp(join(tmpdir(), "agemon-fake-crg-"));
    vi.stubEnv("HOME", home);
    try {
      runFakeSubprocess("pipx", ["install", "code-review-graph"]);
      const afterUnpinned = runFakeSubprocess("code-review-graph", [
        "--version",
      ]);
      runFakeSubprocess("pipx", ["install", PINNED_CRG_SPEC]);
      const installedBinary = fakeCodeReviewGraphOnPath() ?? "";
      const afterPinned = runFakeSubprocess(installedBinary, ["status"]);

      expect(afterUnpinned.code).not.toBe(0);
      expect(
        installedBinary.startsWith(join(home, ".agemon", "fake-pipx")),
      ).toBe(true);
      expect(afterPinned).toMatchObject({ code: 0 });
      expect(afterPinned.stdout).toContain("Nodes:");
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("refuses a global npm install by package name", () => {
    expect(() =>
      runFakeSubprocess("npm", [
        "install",
        "--global",
        "--ignore-scripts",
        `agnix@${AGNIX_VERSION}`,
      ]),
    ).toThrow(/only from a verified tarball/);
  });

  it("leaves an installed skills CLI behind a fake npm ci, as the real one does", async () => {
    const prefix = await mkdtemp(join(tmpdir(), "agemon-fake-npm-ci-"));
    try {
      runFakeSubprocess("npm", ["ci", "--ignore-scripts", "--prefix", prefix]);

      expect(
        existsSync(join(prefix, "node_modules", "skills", "bin", "cli.mjs")),
      ).toBe(true);
    } finally {
      await rm(prefix, { recursive: true, force: true });
    }
  });

  it("refuses an npm call that could read the repository's .npmrc", () => {
    expect(() => runFakeSubprocess("npm", ["install", "agnix"])).toThrow(
      /--global or --prefix/,
    );
    expect(() => runFakeSubprocess("npm", ["root", "--global"])).not.toThrow();
  });

  it("reports the pinned Essentials commit as the fetched HEAD", () => {
    const result = runFakeSubprocess("git", ["rev-parse", "HEAD"]);

    expect(result.stdout.trim()).toBe(ESSENTIALS_SKILLS_COMMIT);
  });
});

describe("createFakeVerifiedBinaryInstaller", () => {
  it("records each request without downloading anything", async () => {
    const request = {
      packageName: "agnix",
      version: AGNIX_VERSION,
      binaryPathInPackage: "bin/agnix-binary",
      archiveMemberName: "agnix",
      candidates: [{ url: "https://example.test/a", sha256: "0".repeat(64) }],
      packageTarball: {
        url: "https://example.test/agnix.tgz",
        integrity: "sha512-x",
      },
    };

    await createFakeVerifiedBinaryInstaller().install(request);

    expect(takeFakeVerifiedBinaryInstallRequests()).toEqual([request]);
    expect(takeFakeVerifiedBinaryInstallRequests()).toEqual([]);
  });

  it("reports a package as installed only once the fake installer installed it", async () => {
    const installer = createFakeVerifiedBinaryInstaller();
    const inspectRequest = {
      packageName: "agnix",
      commandName: "agnix",
      commandPathInPackage: "bin/agnix",
      binaryPathInPackage: "bin/agnix-binary",
      packageFileSha256: {},
      binarySha256: [],
    };

    await expect(installer.inspect(inspectRequest)).resolves.toEqual({
      kind: "absent",
    });
    await installer.install({
      packageName: "agnix",
      version: AGNIX_VERSION,
      binaryPathInPackage: "bin/agnix-binary",
      archiveMemberName: "agnix",
      candidates: [],
      packageTarball: {
        url: "https://example.test/agnix.tgz",
        integrity: "sha512-x",
      },
    });
    await expect(installer.inspect(inspectRequest)).resolves.toMatchObject({
      kind: "installed",
      differences: [],
    });
  });
});
