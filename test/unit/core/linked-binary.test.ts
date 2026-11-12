import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  inspectLinkedBinary,
  isDirectoryOnPath,
  type LinkedBinaryPaths,
  linkBinary,
  linkedBinaryPaths,
  unlinkBinary,
} from "../../../src/core/linked-binary.js";

const NORMAL_UID = 1000;
const ROOT_UID = 0;

let home: string;
let paths: LinkedBinaryPaths;

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "agemon-linked-")));
  paths = linkedBinaryPaths("gitleaks", "8.30.1", "gitleaks", NORMAL_UID, home);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function placeBinary(binaryPath: string): Promise<void> {
  await mkdir(dirname(binaryPath), { recursive: true });
  await writeFile(binaryPath, "#!/bin/sh\necho gitleaks version 8.30.1\n", {
    mode: 0o755,
  });
}

describe("linkedBinaryPaths", () => {
  it("keeps a normal user's tools beside agemon in ~/.local", () => {
    expect(paths).toEqual({
      toolsRoot: join(home, ".local/share/agemon-tools"),
      binaryPath: join(
        home,
        ".local/share/agemon-tools/gitleaks/8.30.1/gitleaks",
      ),
      linkPath: join(home, ".local/bin/gitleaks"),
    });
  });

  it("uses /usr/local for root", () => {
    expect(
      linkedBinaryPaths("gitleaks", "8.30.1", "gitleaks", ROOT_UID, home),
    ).toEqual({
      toolsRoot: "/usr/local/lib/agemon-tools",
      binaryPath: "/usr/local/lib/agemon-tools/gitleaks/8.30.1/gitleaks",
      linkPath: "/usr/local/bin/gitleaks",
    });
  });
});

describe("inspectLinkedBinary", () => {
  it("is absent when nothing is at the link path", async () => {
    expect(await inspectLinkedBinary(paths)).toBe("absent");
  });

  it("is ours-current after linkBinary", async () => {
    await placeBinary(paths.binaryPath);

    await linkBinary(paths);

    expect(await inspectLinkedBinary(paths)).toBe("ours-current");
    expect(await readlink(paths.linkPath)).toBe(paths.binaryPath);
  });

  it("is ours-other-version for a link into another version directory", async () => {
    const olderBinary = join(paths.toolsRoot, "gitleaks/8.0.0/gitleaks");
    await placeBinary(olderBinary);
    await mkdir(dirname(paths.linkPath), { recursive: true });
    await symlink(olderBinary, paths.linkPath);

    expect(await inspectLinkedBinary(paths)).toBe("ours-other-version");
  });

  it("is ours-other-version for a dangling link into the tools root", async () => {
    await mkdir(dirname(paths.linkPath), { recursive: true });
    await symlink(
      join(paths.toolsRoot, "gitleaks/8.0.0/gitleaks"),
      paths.linkPath,
    );

    expect(await inspectLinkedBinary(paths)).toBe("ours-other-version");
  });

  it("is foreign for a regular file", async () => {
    await placeBinary(paths.linkPath);

    expect(await inspectLinkedBinary(paths)).toBe("foreign");
  });

  it("is foreign for a symlink outside the tools root", async () => {
    await mkdir(dirname(paths.linkPath), { recursive: true });
    await symlink("/usr/bin/true", paths.linkPath);

    expect(await inspectLinkedBinary(paths)).toBe("foreign");
  });
});

describe("linkBinary", () => {
  it("refuses a foreign file and leaves it untouched", async () => {
    await placeBinary(paths.binaryPath);
    await mkdir(dirname(paths.linkPath), { recursive: true });
    await writeFile(paths.linkPath, "the user's own gitleaks");

    await expect(linkBinary(paths)).rejects.toThrow(
      `${paths.linkPath} already exists and was not installed by agemon; remove it or keep using your own gitleaks`,
    );
    expect(await readFile(paths.linkPath, "utf8")).toBe(
      "the user's own gitleaks",
    );
  });

  it("replaces a link to another version", async () => {
    const olderBinary = join(paths.toolsRoot, "gitleaks/8.0.0/gitleaks");
    await placeBinary(olderBinary);
    await placeBinary(paths.binaryPath);
    await mkdir(dirname(paths.linkPath), { recursive: true });
    await symlink(olderBinary, paths.linkPath);

    await linkBinary(paths);

    expect(await readlink(paths.linkPath)).toBe(paths.binaryPath);
  });
});

describe("unlinkBinary", () => {
  it("removes our link and the tool's directory", async () => {
    await placeBinary(paths.binaryPath);
    await linkBinary(paths);

    await unlinkBinary(paths);

    expect(await inspectLinkedBinary(paths)).toBe("absent");
    await expect(readFile(paths.binaryPath)).rejects.toThrow(/ENOENT/u);
    await expect(readFile(join(paths.toolsRoot, "gitleaks"))).rejects.toThrow(
      /ENOENT/u,
    );
  });

  it("removes nothing when the link path is foreign", async () => {
    await placeBinary(paths.binaryPath);
    await mkdir(dirname(paths.linkPath), { recursive: true });
    await writeFile(paths.linkPath, "the user's own gitleaks");

    await unlinkBinary(paths);

    expect(await readFile(paths.linkPath, "utf8")).toBe(
      "the user's own gitleaks",
    );
    expect(await readFile(paths.binaryPath, "utf8")).toContain("gitleaks");
  });
});

describe("isDirectoryOnPath", () => {
  it("finds the directory only when the given PATH lists it", async () => {
    const binDirectory = dirname(paths.linkPath);
    await mkdir(binDirectory, { recursive: true });

    expect(
      await isDirectoryOnPath(
        binDirectory,
        ["/usr/bin", binDirectory].join(delimiter),
      ),
    ).toBe(true);
    expect(await isDirectoryOnPath(binDirectory, "/usr/bin")).toBe(false);
  });
});
