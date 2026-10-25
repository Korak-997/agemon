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
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    return runSubprocess(command, args, options);
  };
  return { run, calls };
}

function fetchServing(archivesByUrl: Record<string, Buffer>): typeof fetch {
  return async (input) => {
    const archive = archivesByUrl[String(input)];
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
      fetch: async () => new Response(endlessArchive),
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
      fetch: async () => new Response(droppingArchive),
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

  it("fails before downloading when npm root --global fails", async () => {
    let fetched = false;
    const installer = createVerifiedBinaryInstaller({
      run: createRunner({ code: 1, stdout: "", stderr: "npm is broken" }).run,
      fetch: async () => {
        fetched = true;
        return new Response("");
      },
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
