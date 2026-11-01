import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveInstallMethod,
  resolvePackageRoot,
} from "../../../src/core/install-method.js";
import type { RunSubprocess } from "../../../src/core/subprocess-trace.js";

const createdTempDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

async function createTempDirectory(): Promise<string> {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "agemon-install-method-test-")),
  );
  createdTempDirectories.push(directory);
  return directory;
}

async function createPackageTree(packageRoot: string): Promise<string> {
  await mkdir(join(packageRoot, "dist"), { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "agemon", version: "9.1.0" }),
  );
  return join(packageRoot, "dist");
}

function npmRootAnswering(npmRoot: string): RunSubprocess & {
  mock: { calls: unknown[][] };
} {
  return vi.fn(async () => ({ code: 0, stdout: `${npmRoot}\n`, stderr: "" }));
}

let NPM_MUST_NOT_RUN: RunSubprocess & { mock: { calls: unknown[][] } };

beforeEach(() => {
  NPM_MUST_NOT_RUN = vi.fn(async () => {
    throw new Error("npm must not run for this layout");
  });
});

describe("resolvePackageRoot", () => {
  it("finds the nearest package.json named agemon above a module directory", async () => {
    const root = await createTempDirectory();
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "x" }));
    const packageRoot = join(root, "node_modules", "agemon");
    const moduleDirectory = await createPackageTree(packageRoot);

    expect(resolvePackageRoot(moduleDirectory)).toBe(packageRoot);
  });

  it("skips a package.json that belongs to another package", async () => {
    const root = await createTempDirectory();
    const moduleDirectory = await createPackageTree(root);
    await writeFile(
      join(moduleDirectory, "package.json"),
      JSON.stringify({ name: "not-agemon" }),
    );

    expect(resolvePackageRoot(moduleDirectory)).toBe(root);
  });
});

describe("resolveInstallMethod", () => {
  it("resolves install-script from a regular .agemon-install marker", async () => {
    const installDir = await createTempDirectory();
    await createPackageTree(installDir);
    await writeFile(join(installDir, ".agemon-install"), "9.1.0\n");

    await expect(
      resolveInstallMethod({ packageRoot: installDir, run: NPM_MUST_NOT_RUN }),
    ).resolves.toEqual({ kind: "install-script", installDir });
  });

  it("does not treat a symlinked .agemon-install marker as install-script", async () => {
    const root = await createTempDirectory();
    const installDir = join(root, "agemon");
    await createPackageTree(installDir);
    await writeFile(join(root, "marker"), "9.1.0\n");
    await symlink(join(root, "marker"), join(installDir, ".agemon-install"));

    await expect(
      resolveInstallMethod({ packageRoot: installDir, run: NPM_MUST_NOT_RUN }),
    ).resolves.toEqual({ kind: "unknown", packageRoot: installDir });
  });

  it.each([".git", "src"])(
    "treats a package root with %s as a source checkout",
    async (entry) => {
      const packageRoot = await createTempDirectory();
      await createPackageTree(packageRoot);
      await mkdir(join(packageRoot, entry));
      await writeFile(join(packageRoot, ".agemon-install"), "9.1.0\n");

      await expect(
        resolveInstallMethod({ packageRoot, run: NPM_MUST_NOT_RUN }),
      ).resolves.toEqual({ kind: "dev" });
    },
  );

  it("does not treat a packaged layout as a source checkout under AGEMON_DEV=1", async () => {
    vi.stubEnv("AGEMON_DEV", "1");
    const packageRoot = await createTempDirectory();
    await createPackageTree(packageRoot);

    await expect(
      resolveInstallMethod({ packageRoot, run: NPM_MUST_NOT_RUN }),
    ).resolves.toEqual({ kind: "unknown", packageRoot });
  });

  it("recognises npm's exec cache as npx", async () => {
    const root = await createTempDirectory();
    const packageRoot = join(root, "_npx", "0a1b2c", "node_modules", "agemon");
    await createPackageTree(packageRoot);

    await expect(
      resolveInstallMethod({ packageRoot, run: NPM_MUST_NOT_RUN }),
    ).resolves.toEqual({ kind: "npx" });
  });

  it("matches the global npm root as npm-global and derives its prefix", async () => {
    const prefix = await createTempDirectory();
    const npmRoot = join(prefix, "lib", "node_modules");
    const packageRoot = join(npmRoot, "agemon");
    await createPackageTree(packageRoot);

    await expect(
      resolveInstallMethod({ packageRoot, run: npmRootAnswering(npmRoot) }),
    ).resolves.toEqual({ kind: "npm-global", packageRoot, prefix });
  });

  it("treats a project-local node_modules/agemon as unknown", async () => {
    const root = await createTempDirectory();
    const packageRoot = join(root, "project", "node_modules", "agemon");
    await createPackageTree(packageRoot);
    const globalRoot = join(root, "global", "lib", "node_modules");
    await mkdir(globalRoot, { recursive: true });

    await expect(
      resolveInstallMethod({ packageRoot, run: npmRootAnswering(globalRoot) }),
    ).resolves.toEqual({ kind: "unknown", packageRoot });
  });

  it("treats a global root without the lib/node_modules shape as unknown", async () => {
    const root = await createTempDirectory();
    const npmRoot = join(root, "node_modules");
    const packageRoot = join(npmRoot, "agemon");
    await createPackageTree(packageRoot);

    await expect(
      resolveInstallMethod({ packageRoot, run: npmRootAnswering(npmRoot) }),
    ).resolves.toEqual({ kind: "unknown", packageRoot });
  });

  it("treats a failing npm root lookup as unknown", async () => {
    const root = await createTempDirectory();
    const packageRoot = join(root, "lib", "node_modules", "agemon");
    await createPackageTree(packageRoot);
    const failingNpm = vi.fn(async () => ({
      code: 1,
      stdout: "",
      stderr: "npm: command not found",
    }));

    await expect(
      resolveInstallMethod({ packageRoot, run: failingNpm }),
    ).resolves.toEqual({ kind: "unknown", packageRoot });
  });

  it("does not run npm for an install-script copy inside a node_modules dir", async () => {
    const root = await createTempDirectory();
    const installDir = join(root, "lib", "node_modules", "agemon");
    await createPackageTree(installDir);
    await writeFile(join(installDir, ".agemon-install"), "9.1.0\n");

    await expect(
      resolveInstallMethod({ packageRoot: installDir, run: NPM_MUST_NOT_RUN }),
    ).resolves.toEqual({ kind: "install-script", installDir });
    expect(NPM_MUST_NOT_RUN).not.toHaveBeenCalled();
  });
});
