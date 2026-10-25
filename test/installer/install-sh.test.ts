import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const INSTALL_SCRIPT_PATH = resolve("install.sh");
const RELEASE_VERSION = "9.1.0";
const SHA256SUM_AVAILABLE =
  spawnSync("sh", ["-c", "command -v sha256sum"]).status === 0;
const RUNNING_AS_ROOT = process.getuid?.() === 0;
const PREVIOUS_VERSION = "9.0.0";
const TOOLS_USED_BY_INSTALLER = [
  "awk",
  "basename",
  "cat",
  "chmod",
  "dirname",
  "grep",
  "gzip",
  "head",
  "id",
  "ln",
  "ls",
  "mkdir",
  "mktemp",
  "mv",
  "node",
  "readlink",
  "rm",
  "sed",
  "tar",
  "tr",
];

const FAKE_CURL = `#!/bin/sh
output=""
url=""
config=""
previous=""
for argument in "$@"; do
  case "$previous" in
    -o) output="$argument" ;;
    --config) [ "$argument" = "-" ] && config="$(cat)" ;;
  esac
  case "$argument" in
    https://*) url="$argument" ;;
  esac
  previous="$argument"
done
printf 'argv: %s\\nconfig: %s\\n' "$*" "$config" >> "$FAKE_CURL_LOG"
case "$url" in
  https://api.github.com/repos/Korak-997/agemon/releases/latest) source_file="$FAKE_RELEASE_ROOT/api-latest.json" ;;
  https://github.com/Korak-997/agemon/releases/download/*) source_file="$FAKE_RELEASE_ROOT/download/\${url#https://github.com/Korak-997/agemon/releases/download/}" ;;
  https://github.com/Korak-997/agemon/releases/latest/download/*) source_file="$FAKE_RELEASE_ROOT/latest/\${url#https://github.com/Korak-997/agemon/releases/latest/download/}" ;;
  *) exit 6 ;;
esac
[ -f "$source_file" ] || exit 22
if [ -n "$output" ]; then cat "$source_file" > "$output"; else cat "$source_file"; fi
if [ -n "\${FAKE_CURL_AFTER_TARBALL:-}" ]; then
  case "$url" in */agemon.tgz) /bin/sh -c "$FAKE_CURL_AFTER_TARBALL" ;; esac
fi
`;

interface Sandbox {
  root: string;
  home: string;
  toolsDir: string;
  releaseRoot: string;
  curlLog: string;
}

let sandbox: Sandbox;

function sha256(contents: Buffer | string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function resolveTool(tool: string): string {
  return execFileSync("sh", ["-c", `command -v ${tool}`], {
    encoding: "utf8",
  }).trim();
}

function createSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "agemon-install-sh-test-"));
  const home = join(root, "home");
  const toolsDir = join(root, "tools");
  const releaseRoot = join(root, "release");
  mkdirSync(home);
  mkdirSync(toolsDir);
  mkdirSync(releaseRoot);
  for (const tool of TOOLS_USED_BY_INSTALLER) {
    symlinkSync(resolveTool(tool), join(toolsDir, tool));
  }
  writeFileSync(join(toolsDir, "curl"), FAKE_CURL, { mode: 0o755 });
  return { root, home, toolsDir, releaseRoot, curlLog: join(root, "curl.log") };
}

function linkTool(tool: string): void {
  symlinkSync(resolveTool(tool), join(sandbox.toolsDir, tool));
}

function buildPackageTree(directory: string, version: string): void {
  mkdirSync(join(directory, "bin"), { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ name: "agemon", version }),
  );
  writeFileSync(
    join(directory, "bin", "agemon.js"),
    `#!/usr/bin/env node\nif (process.argv[2] === "--version") console.log("${version}");\n`,
  );
}

function buildTarball(version: string): Buffer {
  const packRoot = mkdtempSync(join(sandbox.root, "pack-"));
  buildPackageTree(join(packRoot, "package"), version);
  const tarballPath = join(packRoot, "agemon.tgz");
  execFileSync("tar", ["-czf", tarballPath, "-C", packRoot, "package"]);
  return readFileSync(tarballPath);
}

function publishRelease(
  options: {
    version?: string;
    checksums?: (tarballHash: string) => string;
  } = {},
): void {
  const version = options.version ?? RELEASE_VERSION;
  const tarball = buildTarball(version);
  const tarballHash = sha256(tarball);
  const checksums =
    options.checksums?.(tarballHash) ??
    `${tarballHash}  agemon.tgz\n${sha256("installer")}  install.sh\n`;
  for (const assetDir of [
    join(sandbox.releaseRoot, "download", `v${version}`),
    join(sandbox.releaseRoot, "latest"),
  ]) {
    mkdirSync(assetDir, { recursive: true });
    writeFileSync(join(assetDir, "agemon.tgz"), tarball);
    writeFileSync(join(assetDir, "SHA256SUMS"), checksums);
  }
  setApiTag(`v${version}`);
}

function setApiTag(tagName: string): void {
  writeFileSync(
    join(sandbox.releaseRoot, "api-latest.json"),
    JSON.stringify({ tag_name: tagName }),
  );
}

function runInstaller(
  env: Record<string, string> = {},
  options: { script?: string; cwd?: string } = {},
) {
  const scriptInput =
    options.script ?? readFileSync(INSTALL_SCRIPT_PATH, "utf8");
  return spawnSync("/bin/sh", ["-s"], {
    input: scriptInput,
    cwd: options.cwd ?? sandbox.root,
    encoding: "utf8",
    env: {
      PATH: sandbox.toolsDir,
      HOME: sandbox.home,
      FAKE_RELEASE_ROOT: sandbox.releaseRoot,
      FAKE_CURL_LOG: sandbox.curlLog,
      ...env,
    },
  });
}

function curlCalls(): string {
  return existsSync(sandbox.curlLog)
    ? readFileSync(sandbox.curlLog, "utf8")
    : "";
}

function snapshotTree(directory: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const entry of readdirSync(directory, {
    recursive: true,
    withFileTypes: true,
  })) {
    const entryPath = join(entry.parentPath, entry.name);
    snapshot[entryPath.slice(directory.length)] = entry.isFile()
      ? sha256(readFileSync(entryPath))
      : entry.isSymbolicLink()
        ? "symlink"
        : "dir";
  }
  return snapshot;
}

function createMarkedInstall(
  directory: string,
  version = PREVIOUS_VERSION,
): void {
  buildPackageTree(directory, version);
  writeFileSync(join(directory, ".agemon-install"), `${version}\n`);
}

function installedVersion(directory: string): string {
  return execFileSync(
    "node",
    [join(directory, "bin", "agemon.js"), "--version"],
    {
      encoding: "utf8",
    },
  ).trim();
}

beforeEach(() => {
  sandbox = createSandbox();
  linkTool("sha256sum");
  publishRelease();
});

afterEach(() => {
  rmSync(sandbox.root, { recursive: true, force: true });
});

describe.skipIf(!SHA256SUM_AVAILABLE)(
  "install.sh install-directory safety",
  () => {
    it.each([
      ["$HOME", () => sandbox.home],
      ["$HOME/", () => `${sandbox.home}/`],
      ["$HOME//", () => `${sandbox.home}//`],
      ["$HOME/.local/share", () => join(sandbox.home, ".local", "share")],
    ])(
      "refuses AGEMON_INSTALL_DIR=%s and leaves it untouched",
      (_label, installDir) => {
        mkdirSync(join(sandbox.home, ".local", "share"), { recursive: true });
        writeFileSync(join(sandbox.home, "notes.txt"), "keep me");
        const before = snapshotTree(sandbox.home);

        const result = runInstaller({ AGEMON_INSTALL_DIR: installDir() });

        expect(result.status).not.toBe(0);
        expect(snapshotTree(sandbox.home)).toEqual(before);
      },
    );

    it("refuses a symlink that points at $HOME", () => {
      const link = join(sandbox.root, "home-link");
      symlinkSync(sandbox.home, link);
      writeFileSync(join(sandbox.home, "notes.txt"), "keep me");

      const result = runInstaller({ AGEMON_INSTALL_DIR: link });

      expect(result.status).not.toBe(0);
      expect(readFileSync(join(sandbox.home, "notes.txt"), "utf8")).toBe(
        "keep me",
      );
    });

    it("refuses a non-empty directory without the install marker", () => {
      const installDir = join(sandbox.root, "project");
      mkdirSync(installDir);
      writeFileSync(join(installDir, "work.txt"), "unsaved work");

      const result = runInstaller({ AGEMON_INSTALL_DIR: installDir });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(installDir);
      expect(readFileSync(join(installDir, "work.txt"), "utf8")).toBe(
        "unsaved work",
      );
    });

    it("refuses a relative install directory", () => {
      const result = runInstaller({ AGEMON_INSTALL_DIR: "agemon" });

      expect(result.status).not.toBe(0);
      expect(existsSync(join(sandbox.root, "agemon"))).toBe(false);
    });

    it.each([
      ["by absolute path", (clone: string) => clone],
      ["as '.'", () => "."],
    ])("refuses an agemon source clone %s", (_label, installDirFor) => {
      const clone = join(sandbox.root, "agemon-clone");
      buildPackageTree(clone, PREVIOUS_VERSION);
      mkdirSync(join(clone, ".git"));
      writeFileSync(join(clone, ".git", "HEAD"), "ref: refs/heads/main\n");
      const before = snapshotTree(clone);

      const result = runInstaller(
        { AGEMON_INSTALL_DIR: installDirFor(clone) },
        { cwd: clone },
      );

      expect(result.status).not.toBe(0);
      expect(snapshotTree(clone)).toEqual(before);
    });

    it.each([["link"], ["link/"]])(
      "refuses a symlinked install directory given as %s",
      (suffix) => {
        const target = join(sandbox.root, "real-install");
        createMarkedInstall(target);
        symlinkSync(target, join(sandbox.root, "link"));
        const before = snapshotTree(target);

        const result = runInstaller({
          AGEMON_INSTALL_DIR: join(sandbox.root, suffix),
        });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("symlink");
        expect(snapshotTree(target)).toEqual(before);
      },
    );

    it("replaces a directory that carries the marker and records the new version", () => {
      const installDir = join(sandbox.root, "custom", "agemon");
      createMarkedInstall(installDir);

      const result = runInstaller({ AGEMON_INSTALL_DIR: installDir });

      expect(result.status, result.stderr).toBe(0);
      expect(installedVersion(installDir)).toBe(RELEASE_VERSION);
      expect(
        readFileSync(join(installDir, ".agemon-install"), "utf8").trim(),
      ).toBe(RELEASE_VERSION);
      expect(statSync(installDir).mode & 0o777).toBe(0o755);
      expect(readdirSync(join(sandbox.root, "custom")).sort()).toEqual([
        "agemon",
        "agemon.prev",
      ]);
    });

    it("upgrades a legacy install at the default path", () => {
      const installDir = join(sandbox.home, ".local", "share", "agemon");
      buildPackageTree(installDir, PREVIOUS_VERSION);

      const result = runInstaller();

      expect(result.status, result.stderr).toBe(0);
      expect(installedVersion(installDir)).toBe(RELEASE_VERSION);
      expect(existsSync(join(installDir, ".agemon-install"))).toBe(true);
    });

    it("upgrades a legacy custom install that has the old bin-link symlink", () => {
      const installDir = join(sandbox.root, "custom-agemon");
      buildPackageTree(installDir, PREVIOUS_VERSION);
      mkdirSync(join(installDir, "bin-link"));
      symlinkSync(
        `${installDir}//bin/agemon.js`,
        join(installDir, "bin-link", "agemon"),
      );

      const result = runInstaller({ AGEMON_INSTALL_DIR: `${installDir}/` });

      expect(result.status, result.stderr).toBe(0);
      expect(installedVersion(installDir)).toBe(RELEASE_VERSION);
    });

    it("refuses a legacy-looking custom directory without the bin-link symlink", () => {
      const installDir = join(sandbox.root, "custom-agemon");
      buildPackageTree(installDir, PREVIOUS_VERSION);

      const result = runInstaller({ AGEMON_INSTALL_DIR: installDir });

      expect(result.status).not.toBe(0);
      expect(installedVersion(installDir)).toBe(PREVIOUS_VERSION);
    });

    it("restores the previous install when moving the new one into place fails", () => {
      const installDir = join(sandbox.root, "custom", "agemon");
      createMarkedInstall(installDir);
      const before = snapshotTree(installDir);
      rmSync(join(sandbox.toolsDir, "mv"));
      writeFileSync(
        join(sandbox.toolsDir, "mv"),
        `#!/bin/sh\ncase "$1" in *.tmp-*) exit 1 ;; esac\nexec ${resolveTool("mv")} "$@"\n`,
        { mode: 0o755 },
      );

      const result = runInstaller({ AGEMON_INSTALL_DIR: installDir });

      expect(result.status).not.toBe(0);
      expect(snapshotTree(installDir)).toEqual(before);
      expect(readdirSync(join(sandbox.root, "custom"))).toEqual(["agemon"]);
    });
    it("keeps the previous install when the install dir reappears during the swap", () => {
      const installDir = join(sandbox.root, "custom", "agemon");
      createMarkedInstall(installDir);
      const realMv = resolveTool("mv");
      rmSync(join(sandbox.toolsDir, "mv"));
      writeFileSync(
        join(sandbox.toolsDir, "mv"),
        `#!/bin/sh\ncase "$1" in *.tmp-*) mkdir -p "$2"; exit 1 ;; esac\nexec ${realMv} "$@"\n`,
        { mode: 0o755 },
      );

      const result = runInstaller({ AGEMON_INSTALL_DIR: installDir });

      expect(result.status).not.toBe(0);
      const asideDirectory = readdirSync(join(sandbox.root, "custom")).find(
        (entry) => entry.startsWith("agemon.old-"),
      );
      expect(asideDirectory).toBeDefined();
      expect(result.stderr).toContain(`${asideDirectory}/previous`);
      expect(
        installedVersion(
          join(sandbox.root, "custom", asideDirectory as string, "previous"),
        ),
      ).toBe(PREVIOUS_VERSION);
    });

    it("re-checks the install dir right before the swap", () => {
      const installDir = join(sandbox.root, "agemon");
      mkdirSync(installDir);

      const result = runInstaller({
        AGEMON_INSTALL_DIR: installDir,
        FAKE_CURL_AFTER_TARBALL: `printf 'new work' > '${installDir}/work.txt'`,
      });

      expect(result.status).not.toBe(0);
      expect(readdirSync(installDir)).toEqual(["work.txt"]);
    });

    it.skipIf(RUNNING_AS_ROOT)(
      "refuses a non-empty directory whose contents cannot be listed",
      () => {
        const installDir = join(sandbox.root, "private");
        mkdirSync(installDir);
        writeFileSync(join(installDir, "secret.txt"), "keep me");
        chmodSync(installDir, 0o300);

        const result = runInstaller({ AGEMON_INSTALL_DIR: installDir });
        chmodSync(installDir, 0o755);

        expect(result.status).not.toBe(0);
        expect(readFileSync(join(installDir, "secret.txt"), "utf8")).toBe(
          "keep me",
        );
      },
    );

    it.each([["/x/.."], ["/."], ["/link/."]])(
      "refuses an install dir with a dot component (%s)",
      (suffix) => {
        const target = join(sandbox.root, "real-install");
        createMarkedInstall(target);
        symlinkSync(target, join(sandbox.root, "link"));
        const before = snapshotTree(target);

        const result = runInstaller({
          AGEMON_INSTALL_DIR: `${sandbox.root}${suffix}`,
        });

        expect(result.status).not.toBe(0);
        expect(snapshotTree(target)).toEqual(before);
        expect(existsSync(join(sandbox.root, "x"))).toBe(false);
      },
    );

    it("accepts the target of a symlinked default install dir as a legacy install", () => {
      const realInstall = join(sandbox.root, "dotfiles", "agemon");
      buildPackageTree(realInstall, PREVIOUS_VERSION);
      mkdirSync(join(sandbox.home, ".local", "share"), { recursive: true });
      symlinkSync(realInstall, join(sandbox.home, ".local", "share", "agemon"));

      const refused = runInstaller();
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain(realInstall);

      const result = runInstaller({ AGEMON_INSTALL_DIR: realInstall });
      expect(result.status, result.stderr).toBe(0);
      expect(installedVersion(realInstall)).toBe(RELEASE_VERSION);
    });
  },
);

describe.skipIf(!SHA256SUM_AVAILABLE)(
  "install.sh download verification",
  () => {
    it("aborts on a checksum mismatch before touching the previous install", () => {
      const installDir = join(sandbox.root, "custom", "agemon");
      createMarkedInstall(installDir);
      const before = snapshotTree(installDir);
      publishRelease({ checksums: () => `${"0".repeat(64)}  agemon.tgz\n` });

      const result = runInstaller({ AGEMON_INSTALL_DIR: installDir });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/checksum/i);
      expect(snapshotTree(installDir)).toEqual(before);
    });

    it("aborts when the release has no SHA256SUMS (releases before verification)", () => {
      rmSync(
        join(
          sandbox.releaseRoot,
          "download",
          `v${RELEASE_VERSION}`,
          "SHA256SUMS",
        ),
      );

      const result = runInstaller({
        AGEMON_INSTALL_DIR: join(sandbox.root, "agemon"),
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("SHA256SUMS");
      expect(existsSync(join(sandbox.root, "agemon"))).toBe(false);
    });

    it.each([
      [
        "a duplicate agemon.tgz line",
        (hash: string) => `${hash}  agemon.tgz\n${hash}  agemon.tgz\n`,
      ],
      [
        "an upper-case hash",
        (hash: string) => `${hash.toUpperCase()}  agemon.tgz\n`,
      ],
      ["a single-space separator", (hash: string) => `${hash} agemon.tgz\n`],
    ])("aborts when SHA256SUMS has %s", (_label, checksums) => {
      publishRelease({ checksums });

      const result = runInstaller({
        AGEMON_INSTALL_DIR: join(sandbox.root, "agemon"),
      });

      expect(result.status).not.toBe(0);
      expect(existsSync(join(sandbox.root, "agemon"))).toBe(false);
    });

    it("accepts a SHA256SUMS file with CRLF line endings", () => {
      publishRelease({ checksums: (hash) => `${hash}  agemon.tgz\r\n` });

      const result = runInstaller({
        AGEMON_INSTALL_DIR: join(sandbox.root, "agemon"),
      });

      expect(result.status, result.stderr).toBe(0);
    });

    it("verifies with shasum when sha256sum is unavailable", () => {
      rmSync(join(sandbox.toolsDir, "sha256sum"));
      writeFileSync(
        join(sandbox.toolsDir, "shasum"),
        `#!/bin/sh\n[ "$1" = "-a" ] && [ "$2" = "256" ] || exit 2\nexec ${resolveTool("sha256sum")} "$3"\n`,
        { mode: 0o755 },
      );

      const result = runInstaller({
        AGEMON_INSTALL_DIR: join(sandbox.root, "agemon"),
      });

      expect(result.status, result.stderr).toBe(0);
    });

    it("aborts before downloading when no SHA-256 tool is available", () => {
      rmSync(join(sandbox.toolsDir, "sha256sum"));

      const result = runInstaller({
        AGEMON_INSTALL_DIR: join(sandbox.root, "agemon"),
      });

      expect(result.status).not.toBe(0);
      expect(curlCalls()).toBe("");
    });

    it("aborts when attestation verification is requested but gh is unavailable", () => {
      const result = runInstaller({
        AGEMON_INSTALL_DIR: join(sandbox.root, "agemon"),
        AGEMON_VERIFY_ATTESTATION: "1",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("gh");
      expect(existsSync(join(sandbox.root, "agemon"))).toBe(false);
    });
  },
);

describe.skipIf(!SHA256SUM_AVAILABLE)("install.sh input validation", () => {
  it.each([
    ["1.2.3;rm"],
    ["../x"],
    ["1.2.3\nx"],
    [`1.2.3-rc.${"1".repeat(60)}`],
    ["1.2"],
  ])("rejects AGEMON_VERSION=%j before any download", (version) => {
    const result = runInstaller({
      AGEMON_INSTALL_DIR: join(sandbox.root, "agemon"),
      AGEMON_VERSION: version,
    });

    expect(result.status).not.toBe(0);
    expect(curlCalls()).toBe("");
  });

  it("installs a valid pinned release candidate version", () => {
    publishRelease({ version: "9.2.0-rc.1" });

    const result = runInstaller({
      AGEMON_INSTALL_DIR: join(sandbox.root, "agemon"),
      AGEMON_VERSION: "v9.2.0-rc.1",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(installedVersion(join(sandbox.root, "agemon"))).toBe("9.2.0-rc.1");
  });

  it("aborts on a malformed tag_name from the GitHub API", () => {
    setApiTag("v9.1.0;touch pwned");

    const result = runInstaller({
      AGEMON_INSTALL_DIR: join(sandbox.root, "agemon"),
    });

    expect(result.status).not.toBe(0);
    expect(curlCalls()).not.toContain("releases/download");
  });

  it("sends GITHUB_TOKEN only to the API, and never on the command line", () => {
    const result = runInstaller({
      AGEMON_INSTALL_DIR: join(sandbox.root, "agemon"),
      GITHUB_TOKEN: "ghp_secret_token_value",
    });

    expect(result.status, result.stderr).toBe(0);
    const calls = curlCalls().split("argv: ").filter(Boolean);
    const apiCalls = calls.filter((call) => call.includes("api.github.com"));
    const downloadCalls = calls.filter(
      (call) => !call.includes("api.github.com"),
    );
    expect(apiCalls).toHaveLength(1);
    expect(apiCalls[0]).toMatch(/config: .*ghp_secret_token_value/);
    expect(apiCalls[0].split("\nconfig:")[0]).not.toContain(
      "ghp_secret_token_value",
    );
    for (const call of downloadCalls) {
      expect(call).not.toContain("ghp_secret_token_value");
    }
  });

  it("runs nothing when the piped script is truncated", () => {
    const script = readFileSync(INSTALL_SCRIPT_PATH, "utf8");
    const truncated = script.slice(0, Math.floor(script.length / 2));

    runInstaller(
      { AGEMON_INSTALL_DIR: join(sandbox.root, "agemon") },
      { script: truncated },
    );

    expect(curlCalls()).toBe("");
    expect(existsSync(join(sandbox.root, "agemon"))).toBe(false);
  });
});

describe.skipIf(!SHA256SUM_AVAILABLE)("install.sh fixture sanity", () => {
  it("installs a fresh release into a new directory", () => {
    const installDir = join(sandbox.root, "agemon");

    const result = runInstaller({ AGEMON_INSTALL_DIR: installDir });

    expect(result.status, result.stderr).toBe(0);
    expect(installedVersion(installDir)).toBe(RELEASE_VERSION);
  });
});

describe.skipIf(!SHA256SUM_AVAILABLE)("install.sh Node.js version gate", () => {
  function reportNodeVersion(version: string): void {
    const nodeLink = join(sandbox.toolsDir, "node");
    const realNode = resolveTool("node");
    rmSync(nodeLink);
    writeFileSync(
      nodeLink,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi\nexec "${realNode}" "$@"\n`,
      { mode: 0o755 },
    );
  }

  it.each(["v22.12.0", "v22.23.2", "v24.0.0"])("accepts Node %s", (version) => {
    reportNodeVersion(version);

    const result = runInstaller({
      AGEMON_INSTALL_DIR: join(sandbox.root, "agemon"),
    });

    expect(result.status, result.stderr).toBe(0);
  });

  it.each(["v21.7.3", "v22.11.0", "v20.20.2"])("rejects Node %s", (version) => {
    reportNodeVersion(version);

    const result = runInstaller({
      AGEMON_INSTALL_DIR: join(sandbox.root, "agemon"),
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Required: Node.js 22.12+");
    expect(curlCalls()).toBe("");
  });
});

describe.skipIf(!SHA256SUM_AVAILABLE)("install.sh rollback copy", () => {
  const customDir = () => join(sandbox.root, "custom");
  const installDir = () => join(customDir(), "agemon");
  const previousDir = () => `${installDir()}.prev`;

  it("keeps the replaced install as .prev", () => {
    createMarkedInstall(installDir());

    const result = runInstaller({ AGEMON_INSTALL_DIR: installDir() });

    expect(result.status, result.stderr).toBe(0);
    expect(installedVersion(installDir())).toBe(RELEASE_VERSION);
    expect(installedVersion(previousDir())).toBe(PREVIOUS_VERSION);
    expect(result.stdout).toContain(
      `Kept the previous install at ${previousDir()}`,
    );
  });

  it("replaces an older rollback copy the installer made", () => {
    createMarkedInstall(installDir());
    createMarkedInstall(previousDir(), "8.0.0");

    const result = runInstaller({ AGEMON_INSTALL_DIR: installDir() });

    expect(result.status, result.stderr).toBe(0);
    expect(installedVersion(previousDir())).toBe(PREVIOUS_VERSION);
    expect(readdirSync(customDir()).sort()).toEqual(["agemon", "agemon.prev"]);
  });

  it("leaves a .prev it did not create alone and says so", () => {
    createMarkedInstall(installDir());
    mkdirSync(previousDir(), { recursive: true });
    writeFileSync(join(previousDir(), "notes.txt"), "mine");

    const result = runInstaller({ AGEMON_INSTALL_DIR: installDir() });

    expect(result.status, result.stderr).toBe(0);
    expect(readdirSync(previousDir())).toEqual(["notes.txt"]);
    expect(result.stdout).toContain("Kept no rollback copy");
    expect(readdirSync(customDir()).sort()).toEqual(["agemon", "agemon.prev"]);
  });

  it("leaves a symlinked .prev alone", () => {
    createMarkedInstall(installDir());
    const target = join(sandbox.root, "elsewhere");
    createMarkedInstall(target, "8.0.0");
    symlinkSync(target, previousDir());

    const result = runInstaller({ AGEMON_INSTALL_DIR: installDir() });

    expect(result.status, result.stderr).toBe(0);
    expect(installedVersion(target)).toBe("8.0.0");
    expect(result.stdout).toContain("Kept no rollback copy");
  });

  it("keeps no rollback copy on a first install or over an empty directory", () => {
    mkdirSync(installDir(), { recursive: true });

    const result = runInstaller({ AGEMON_INSTALL_DIR: installDir() });

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(previousDir())).toBe(false);
    expect(readdirSync(customDir())).toEqual(["agemon"]);
  });
});
