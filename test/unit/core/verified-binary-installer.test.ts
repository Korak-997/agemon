import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type RunSubprocessOptions,
  runSubprocess,
  type SubprocessResult,
} from "../../../src/core/subprocess-runner.js";
import {
  createVerifiedBinaryInstaller,
  installVerifiedArchive,
  type VerifiedBinaryInstallRequest,
} from "../../../src/core/verified-binary-installer.js";

const PACKAGE_NAME = "agnix";
const PACKAGE_VERSION = "0.58.0";
const BINARY_PATH_IN_PACKAGE = join("bin", "agnix-binary");
const RUNNING_BINARY = "#!/bin/sh\necho 'agnix fixture'\n";
const FAILING_BINARY = "#!/bin/sh\nexit 1\n";
const TARBALL_URL = "https://registry.npmjs.org/agnix/-/agnix-0.58.0.tgz";
const TARBALL = Buffer.from("agnix tarball bytes");

function npmIntegrity(contents: Buffer): string {
  return `sha512-${createHash("sha512").update(contents).digest("base64")}`;
}

let workDirectory: string;
let npmRoot: string;
let packageDirectory: string;

beforeEach(async () => {
  workDirectory = await mkdtemp(join(tmpdir(), "agemon-verified-binary-"));
  npmRoot = join(workDirectory, "npm-root");
  packageDirectory = join(npmRoot, PACKAGE_NAME);
  await mkdir(join(packageDirectory, "bin"), { recursive: true });
  await writePackageManifest(PACKAGE_VERSION);
});

afterEach(async () => {
  await rm(workDirectory, { recursive: true, force: true });
});

async function writePackageManifest(version: string): Promise<void> {
  await writeFile(
    join(packageDirectory, "package.json"),
    JSON.stringify({ name: PACKAGE_NAME, version }),
    "utf8",
  );
}

let fixtureCount = 0;

async function buildFixtureArchive(binaryContents: string): Promise<Buffer> {
  fixtureCount += 1;
  const sourceDirectory = join(workDirectory, `fixture-${fixtureCount}`);
  await mkdir(sourceDirectory);
  await writeFile(join(sourceDirectory, "agnix"), binaryContents, {
    mode: 0o755,
  });
  const archivePath = join(workDirectory, `fixture-${fixtureCount}.tar.gz`);
  execFileSync("tar", ["-czf", archivePath, "-C", sourceDirectory, "agnix"]);
  return readFile(archivePath);
}

function sha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

type RunCall = [string, string[], RunSubprocessOptions | undefined];

function createRunner(
  npmRootResult: SubprocessResult = {
    code: 0,
    stdout: `${npmRoot}\n`,
    stderr: "",
  },
) {
  const calls: RunCall[] = [];
  const run = async (
    command: string,
    args: string[],
    options?: RunSubprocessOptions,
  ): Promise<SubprocessResult> => {
    calls.push([command, args, options]);
    if (command === "npm" && args.join(" ") === "root --global") {
      return npmRootResult;
    }
    if (command === "npm" && args[0] === "install") {
      return { code: 0, stdout: "", stderr: "" };
    }
    return runSubprocess(command, args, options);
  };
  return { run, calls };
}

function withTarball(fetchArchive: typeof fetch): typeof fetch {
  return async (input, init) =>
    String(input) === TARBALL_URL
      ? new Response(TARBALL)
      : fetchArchive(input, init);
}

function fetchServing(archivesByUrl: Record<string, Buffer>): typeof fetch {
  return async (input) => {
    const archive = { [TARBALL_URL]: TARBALL, ...archivesByUrl }[String(input)];
    if (!archive) {
      return new Response("not found", { status: 404 });
    }
    return new Response(archive);
  };
}

function requestFor(
  candidates: VerifiedBinaryInstallRequest["candidates"],
): VerifiedBinaryInstallRequest {
  return {
    packageName: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    binaryPathInPackage: BINARY_PATH_IN_PACKAGE,
    archiveMemberName: "agnix",
    candidates,
    packageTarball: { url: TARBALL_URL, integrity: npmIntegrity(TARBALL) },
  };
}

async function extractionLeftovers(): Promise<string[]> {
  return (await readdir(packageDirectory)).filter((name) =>
    name.startsWith(".agemon-extract-"),
  );
}

describe("installVerifiedArchive", () => {
  it("extracts a matching archive and moves the binary into place", async () => {
    const archive = await buildFixtureArchive(RUNNING_BINARY);
    const targetPath = join(packageDirectory, BINARY_PATH_IN_PACKAGE);

    const installed = await installVerifiedArchive({
      archive,
      expectedSha256: sha256(archive),
      archiveMemberName: "agnix",
      extractionParent: packageDirectory,
      targetPath,
      run: createRunner().run,
    });

    expect(installed).toEqual({ binaryRuns: true });
    expect(await readFile(targetPath, "utf8")).toBe(RUNNING_BINARY);
    expect((await stat(targetPath)).mode & 0o777).toBe(0o755);
    expect(await extractionLeftovers()).toEqual([]);
  });

  it("rejects an archive whose sha256 differs, naming both hashes", async () => {
    const archive = await buildFixtureArchive(RUNNING_BINARY);
    const pinnedSha256 = "0".repeat(64);
    const { run, calls } = createRunner();
    const targetPath = join(packageDirectory, BINARY_PATH_IN_PACKAGE);

    await expect(
      installVerifiedArchive({
        archive,
        expectedSha256: pinnedSha256,
        archiveMemberName: "agnix",
        extractionParent: packageDirectory,
        targetPath,
        run,
      }),
    ).rejects.toThrow(
      new RegExp(`expected ${pinnedSha256}, got ${sha256(archive)}`),
    );
    expect(calls).toEqual([]);
    expect(existsSync(targetPath)).toBe(false);
    expect(await extractionLeftovers()).toEqual([]);
  });

  it("reports a binary that does not run without moving it into place", async () => {
    const archive = await buildFixtureArchive(FAILING_BINARY);
    const targetPath = join(packageDirectory, BINARY_PATH_IN_PACKAGE);
    const { run, calls } = createRunner();

    const installed = await installVerifiedArchive({
      archive,
      expectedSha256: sha256(archive),
      archiveMemberName: "agnix",
      extractionParent: packageDirectory,
      targetPath,
      run,
    });

    expect(installed).toEqual({
      binaryRuns: false,
      probeFailure: "agnix --version exited 1",
    });
    expect(existsSync(targetPath)).toBe(false);
    expect(await extractionLeftovers()).toEqual([]);
    const [tarCommand, tarArgs, tarOptions] = calls[0] ?? [];
    expect(tarCommand).toBe("tar");
    expect(tarArgs?.at(-1)).toBe("agnix");
    expect(tarOptions?.cwd?.startsWith(packageDirectory)).toBe(true);
  });
});

describe("createVerifiedBinaryInstaller", () => {
  it("installs the first candidate whose verified binary runs", async () => {
    const archive = await buildFixtureArchive(RUNNING_BINARY);
    const installer = createVerifiedBinaryInstaller({
      run: createRunner().run,
      fetch: fetchServing({ "https://example.test/gnu.tar.gz": archive }),
    });

    await installer.install(
      requestFor([
        { url: "https://example.test/gnu.tar.gz", sha256: sha256(archive) },
      ]),
    );

    expect(
      await readFile(join(packageDirectory, BINARY_PATH_IN_PACKAGE), "utf8"),
    ).toBe(RUNNING_BINARY);
  });

  it("falls back to the next candidate when the first binary does not run", async () => {
    const gnuArchive = await buildFixtureArchive(FAILING_BINARY);
    const muslArchive = await buildFixtureArchive(RUNNING_BINARY);
    const installer = createVerifiedBinaryInstaller({
      run: createRunner().run,
      fetch: fetchServing({
        "https://example.test/gnu.tar.gz": gnuArchive,
        "https://example.test/musl.tar.gz": muslArchive,
      }),
    });

    await installer.install(
      requestFor([
        {
          url: "https://example.test/gnu.tar.gz",
          sha256: sha256(gnuArchive),
        },
        {
          url: "https://example.test/musl.tar.gz",
          sha256: sha256(muslArchive),
        },
      ]),
    );

    expect(
      await readFile(join(packageDirectory, BINARY_PATH_IN_PACKAGE), "utf8"),
    ).toBe(RUNNING_BINARY);
  });

  it("fails when no candidate's binary runs on this host", async () => {
    const archive = await buildFixtureArchive(FAILING_BINARY);
    const installer = createVerifiedBinaryInstaller({
      run: createRunner().run,
      fetch: fetchServing({ "https://example.test/gnu.tar.gz": archive }),
    });

    await expect(
      installer.install(
        requestFor([
          { url: "https://example.test/gnu.tar.gz", sha256: sha256(archive) },
        ]),
      ),
    ).rejects.toThrow(
      "No pinned agnix 0.58.0 build runs on this host (agnix --version exited 1).",
    );
  });

  it("does not try the next candidate when a download fails", async () => {
    const archive = await buildFixtureArchive(RUNNING_BINARY);
    const installer = createVerifiedBinaryInstaller({
      run: createRunner().run,
      fetch: fetchServing({ "https://example.test/musl.tar.gz": archive }),
    });

    await expect(
      installer.install(
        requestFor([
          { url: "https://example.test/gnu.tar.gz", sha256: sha256(archive) },
          { url: "https://example.test/musl.tar.gz", sha256: sha256(archive) },
        ]),
      ),
    ).rejects.toThrow("Downloading https://example.test/gnu.tar.gz failed");
    expect(existsSync(join(packageDirectory, BINARY_PATH_IN_PACKAGE))).toBe(
      false,
    );
  });

  it("refuses a download larger than the archive cap", async () => {
    const oneMebibyte = new Uint8Array(1024 * 1024);
    let chunksSent = 0;
    const endlessArchive = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksSent += 1;
        controller.enqueue(oneMebibyte);
      },
    });
    const installer = createVerifiedBinaryInstaller({
      run: createRunner().run,
      fetch: withTarball(async () => new Response(endlessArchive)),
    });

    await expect(
      installer.install(
        requestFor([
          { url: "https://example.test/huge.tar.gz", sha256: "0".repeat(64) },
        ]),
      ),
    ).rejects.toThrow(
      "Downloading https://example.test/huge.tar.gz failed: the archive exceeded",
    );
    expect(chunksSent).toBeLessThan(60);
  });

  it("names the URL when the connection drops mid-download", async () => {
    const droppingArchive = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(10));
        controller.error(new Error("terminated"));
      },
    });
    const installer = createVerifiedBinaryInstaller({
      run: createRunner().run,
      fetch: withTarball(async () => new Response(droppingArchive)),
    });

    await expect(
      installer.install(
        requestFor([{ url: "https://example.test/a", sha256: "0".repeat(64) }]),
      ),
    ).rejects.toThrow("Downloading https://example.test/a failed: terminated");
  });

  it("refuses an npm root that does not exist", async () => {
    const installer = createVerifiedBinaryInstaller({
      run: createRunner({
        code: 0,
        stdout: "/home/u/***/lib/node_modules\n",
        stderr: "",
      }).run,
      fetch: fetchServing({}),
    });

    await expect(
      installer.install(
        requestFor([{ url: "https://example.test/a", sha256: "0".repeat(64) }]),
      ),
    ).rejects.toThrow("which is not a directory");
  });

  it("explains a package directory without a readable package.json", async () => {
    await rm(join(packageDirectory, "package.json"));
    const installer = createVerifiedBinaryInstaller({
      run: createRunner().run,
      fetch: fetchServing({}),
    });

    await expect(
      installer.install(
        requestFor([{ url: "https://example.test/a", sha256: "0".repeat(64) }]),
      ),
    ).rejects.toThrow("does not hold an npm-installed package");
  });

  it("fails before downloading the binary archive when npm root --global fails", async () => {
    let fetched = false;
    const installer = createVerifiedBinaryInstaller({
      run: createRunner({ code: 1, stdout: "", stderr: "npm is broken" }).run,
      fetch: withTarball(async () => {
        fetched = true;
        return new Response("");
      }),
    });

    await expect(
      installer.install(
        requestFor([{ url: "https://example.test/a", sha256: "0".repeat(64) }]),
      ),
    ).rejects.toThrow("npm root --global failed: npm is broken");
    expect(fetched).toBe(false);
  });

  it("refuses an npm root that is not an absolute path", async () => {
    const installer = createVerifiedBinaryInstaller({
      run: createRunner({ code: 0, stdout: "relative/root\n", stderr: "" }).run,
      fetch: fetchServing({}),
    });

    await expect(
      installer.install(
        requestFor([{ url: "https://example.test/a", sha256: "0".repeat(64) }]),
      ),
    ).rejects.toThrow("not an absolute path");
  });

  it("refuses to write into a package at another version", async () => {
    await writePackageManifest("0.59.3");
    const installer = createVerifiedBinaryInstaller({
      run: createRunner().run,
      fetch: fetchServing({}),
    });

    await expect(
      installer.install(
        requestFor([{ url: "https://example.test/a", sha256: "0".repeat(64) }]),
      ),
    ).rejects.toThrow("holds agnix 0.59.3, expected 0.58.0");
  });
});

describe("createVerifiedBinaryInstaller npm tarball", () => {
  it("installs agnix from the sha512-verified tarball by path, never by name", async () => {
    const archive = await buildFixtureArchive(RUNNING_BINARY);
    const { run, calls } = createRunner();
    const installer = createVerifiedBinaryInstaller({
      run,
      fetch: fetchServing({ "https://example.test/a.tgz": archive }),
    });

    await installer.install(
      requestFor([
        { url: "https://example.test/a.tgz", sha256: sha256(archive) },
      ]),
    );

    const npmInstall = calls.find(
      ([command, args]) => command === "npm" && args[0] === "install",
    );
    expect(npmInstall?.[1].slice(0, 6)).toEqual([
      "install",
      "--global",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-update-notifier",
    ]);
    const tarballPath = npmInstall?.[1].at(-1) ?? "";
    expect(tarballPath).toMatch(/\/agnix-0\.58\.0\.tgz$/);
    expect(npmInstall?.[2]?.cwd).toBe(join(tarballPath, ".."));
    expect(existsSync(tarballPath)).toBe(false);
  });

  it("refuses a tarball whose integrity differs and runs no npm install", async () => {
    const { run, calls } = createRunner();
    const installer = createVerifiedBinaryInstaller({
      run,
      fetch: fetchServing({ [TARBALL_URL]: Buffer.from("tampered") }),
    });

    await expect(installer.install(requestFor([]))).rejects.toThrow(
      /does not match its pinned sha512; nothing was installed/,
    );
    expect(
      calls.some(
        ([command, args]) => command === "npm" && args[0] === "install",
      ),
    ).toBe(false);
  });
});

describe("createVerifiedBinaryInstaller inspect", () => {
  const WRAPPER = "#!/usr/bin/env node\n// wrapper\n";
  let binaryContents: Buffer;
  let pathDirectory: string;

  function inspectRequest(overrides: { binarySha256?: string[] } = {}) {
    return {
      packageName: PACKAGE_NAME,
      commandName: "agnix",
      commandPathInPackage: join("bin", "agnix"),
      binaryPathInPackage: BINARY_PATH_IN_PACKAGE,
      packageFileSha256: {
        "package.json": sha256(
          Buffer.from(
            JSON.stringify({ name: PACKAGE_NAME, version: PACKAGE_VERSION }),
          ),
        ),
        "bin/agnix": sha256(Buffer.from(WRAPPER)),
      },
      binarySha256: overrides.binarySha256 ?? [sha256(binaryContents)],
    };
  }

  beforeEach(async () => {
    binaryContents = Buffer.alloc(9 * 1024 * 1024, 0x41);
    await writeFile(join(packageDirectory, "bin", "agnix"), WRAPPER, {
      mode: 0o755,
    });
    await writeFile(
      join(packageDirectory, BINARY_PATH_IN_PACKAGE),
      binaryContents,
      {
        mode: 0o755,
      },
    );
    pathDirectory = join(workDirectory, "path-bin");
    await mkdir(pathDirectory);
    await symlink(
      join(packageDirectory, "bin", "agnix"),
      join(pathDirectory, "agnix"),
    );
    vi.stubEnv("PATH", pathDirectory);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function inspect(overrides: Parameters<typeof inspectRequest>[0] = {}) {
    return createVerifiedBinaryInstaller({ run: createRunner().run }).inspect(
      inspectRequest(overrides),
    );
  }

  it("finds a pinned install, hashing a binary larger than 8 MiB", async () => {
    await expect(inspect()).resolves.toEqual({
      kind: "installed",
      version: PACKAGE_VERSION,
      differences: [],
    });
  });

  it("reports a binary that is not a pinned build", async () => {
    const inspection = await inspect({ binarySha256: ["0".repeat(64)] });

    expect(inspection).toMatchObject({
      differences: [`${BINARY_PATH_IN_PACKAGE} is not a pinned build`],
    });
  });

  it("reports a differing package.json", async () => {
    await writePackageManifest("0.58.0-evil");

    expect(await inspect()).toMatchObject({
      version: "0.58.0-evil",
      differences: ["package.json differs"],
    });
  });

  it("reports a symlinked bin/agnix as unreadable", async () => {
    const elsewhere = join(workDirectory, "wrapper-elsewhere");
    await writeFile(elsewhere, WRAPPER);
    await rm(join(packageDirectory, "bin", "agnix"));
    await symlink(elsewhere, join(packageDirectory, "bin", "agnix"));

    const inspection = await inspect();

    expect(
      inspection.kind === "installed" && inspection.differences[0],
    ).toMatch(/^bin\/agnix unreadable/);
  });

  it("reports a symlinked package directory", async () => {
    const realPackage = join(workDirectory, "real-agnix");
    const { rename } = await import("node:fs/promises");
    await rename(packageDirectory, realPackage);
    await symlink(realPackage, packageDirectory);

    const inspection = await inspect();

    expect(inspection.kind === "installed" && inspection.differences).toContain(
      `${packageDirectory} is not a real directory`,
    );
  });

  it("reports an agnix on PATH that is not the npm copy", async () => {
    await rm(join(pathDirectory, "agnix"));
    await writeFile(join(pathDirectory, "agnix"), WRAPPER, { mode: 0o755 });

    expect(await inspect()).toMatchObject({
      differences: [`agnix on PATH is not the npm copy at ${packageDirectory}`],
    });
  });

  it("reports an absent package", async () => {
    await rm(packageDirectory, { recursive: true });

    await expect(inspect()).resolves.toEqual({ kind: "absent" });
  });

  it("reports a failing npm root as a difference instead of throwing", async () => {
    const installer = createVerifiedBinaryInstaller({
      run: createRunner({ code: 1, stdout: "", stderr: "npm broke" }).run,
    });

    await expect(installer.inspect(inspectRequest())).resolves.toMatchObject({
      kind: "installed",
      differences: [
        expect.stringContaining("could not locate the global npm root"),
      ],
    });
  });
});
