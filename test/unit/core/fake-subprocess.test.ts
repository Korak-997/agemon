import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakePinnedSkillManifest } from "../../../src/core/fake-pinned-skills.js";
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
  it("answers skills calls only through the pinned CLI path", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agemon-fake-skills-"));
    const pinned = runFakeSubprocess(
      process.execPath,
      [PINNED_SKILLS_CLI, "list", "--json"],
      { cwd },
    );
    const unpinned = runFakeSubprocess("npx", ["skills", "list", "--json"]);

    expect(isJsonList(pinned.stdout)).toBe(true);
    expect(isJsonList(unpinned.stdout)).toBe(false);
  });

  it("refuses skills calls without the repository as cwd", () => {
    const result = runFakeSubprocess(process.execPath, [
      PINNED_SKILLS_CLI,
      "list",
      "--json",
    ]);

    expect(result.code).toBe(1);
  });

  it("copies an added skill into .claude/skills like the real CLI, and removes only that copy", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agemon-fake-skills-"));
    const source = await mkdtemp(join(tmpdir(), "agemon-fake-source-"));
    await writeFile(join(source, "SKILL.md"), "---\nname: x\n---\n");
    await writeFile(join(source, "metadata.json"), "{}");
    await mkdir(join(source, "__pycache__"));
    await mkdir(join(cwd, ".agents/skills/x"), { recursive: true });
    await writeFile(join(cwd, ".agents/skills/x/marker"), "user");
    const cli = (...args: string[]) =>
      runFakeSubprocess(process.execPath, [PINNED_SKILLS_CLI, ...args], {
        cwd,
      });

    cli("add", source, "--skill", "x", "--agent", "claude-code", "--yes");
    const afterAdd = JSON.parse(cli("list", "--json").stdout);
    const copied = await readdir(join(cwd, ".claude/skills/x"));
    cli("remove", "x", "--agent", "claude-code", "--yes");

    expect(afterAdd).toMatchObject([{ name: "x" }]);
    expect(copied).toEqual(["SKILL.md"]);
    expect(existsSync(join(cwd, ".claude/skills/x"))).toBe(false);
    expect(existsSync(join(cwd, ".agents/skills/x/marker"))).toBe(true);
    expect(existsSync(join(cwd, "skills-lock.json"))).toBe(false);
  });

  it("replaces a symlinked or edited copy and lists skills found under .agents/skills too", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agemon-fake-skills-"));
    const source = await mkdtemp(join(tmpdir(), "agemon-fake-source-"));
    const outside = await mkdtemp(join(tmpdir(), "agemon-fake-outside-"));
    await writeFile(join(source, "SKILL.md"), "---\nname: x\n---\n");
    await writeFile(join(outside, "keep"), "outside");
    await mkdir(join(cwd, ".claude/skills"), { recursive: true });
    await symlink(outside, join(cwd, ".claude/skills/x"));
    await mkdir(join(cwd, ".agents/skills/y"), { recursive: true });
    await writeFile(join(cwd, ".agents/skills/y/SKILL.md"), "y");

    const listed = runFakeSubprocess(
      process.execPath,
      [PINNED_SKILLS_CLI, "add", source, "--skill", "x"],
      { cwd },
    );
    const names = JSON.parse(
      runFakeSubprocess(process.execPath, [PINNED_SKILLS_CLI, "list"], {
        cwd,
      }).stdout,
    ).map((skill: { name: string }) => skill.name);

    expect(listed.code).toBe(0);
    expect(names).toEqual(["x", "y"]);
    expect(existsSync(join(outside, "keep"))).toBe(true);
    expect(await readdir(join(cwd, ".claude/skills/x"))).toEqual(["SKILL.md"]);
  });

  it("refuses skill names that are not plain names on add and remove", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agemon-fake-skills-"));
    const cli = (...args: string[]) =>
      runFakeSubprocess(process.execPath, [PINNED_SKILLS_CLI, ...args], {
        cwd,
      });

    expect(cli("add", "/nowhere", "--skill", "../escape").code).toBe(1);
    expect(cli("remove", "../escape", "--yes").code).toBe(1);
    expect(existsSync(join(cwd, ".claude/escape"))).toBe(false);
  });

  it("writes stand-ins for the pinned skills on checkout", async () => {
    const sourceDirectory = join(
      await mkdtemp(join(tmpdir(), "agemon-fake-pinned-")),
      ESSENTIALS_SKILLS_COMMIT,
    );
    await mkdir(sourceDirectory);

    runFakeSubprocess("git", ["checkout", "-q", "FETCH_HEAD"], {
      cwd: sourceDirectory,
    });

    expect(
      await readFile(
        join(sourceDirectory, "skills/writing-guidelines/SKILL.md"),
        "utf8",
      ),
    ).toBe(fakePinnedSkillManifest("writing-guidelines"));
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
