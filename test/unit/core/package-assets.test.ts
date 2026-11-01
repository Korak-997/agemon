import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePackageRootFrom } from "../../../src/core/package-assets.js";

const createdTempDirectories: string[] = [];

afterEach(async () => {
  for (const directoryPath of createdTempDirectories.splice(0)) {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

async function createPackage(
  directory: string,
  name: string,
  withSkills: boolean,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ name }));
  if (withSkills) {
    await mkdir(join(directory, "assets", "skills"), { recursive: true });
  }
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agemon-package-assets-"));
  createdTempDirectories.push(root);
  return root;
}

describe("resolvePackageRootFrom", () => {
  it("accepts the nearest package.json named agemon that has assets/skills", async () => {
    const root = await createRoot();
    const packageRoot = join(root, "agemon");
    await createPackage(packageRoot, "agemon", true);
    await mkdir(join(packageRoot, "dist"), { recursive: true });

    expect(resolvePackageRootFrom(join(packageRoot, "dist"))).toBe(packageRoot);
  });

  it("refuses when the nearest package.json has another name, even if an ancestor has assets/skills", async () => {
    const root = await createRoot();
    await createPackage(root, "agemon", true);
    const foreign = join(root, "node_modules", "other");
    await createPackage(foreign, "other", true);

    expect(() => resolvePackageRootFrom(foreign)).toThrow(
      "Unable to locate agemon's vendored assets/skills directory.",
    );
  });

  it("refuses an agemon package without assets/skills instead of searching further up", async () => {
    const root = await createRoot();
    await mkdir(join(root, "assets", "skills"), { recursive: true });
    const packageRoot = join(root, "agemon");
    await createPackage(packageRoot, "agemon", false);

    expect(() => resolvePackageRootFrom(packageRoot)).toThrow(
      "Unable to locate agemon's vendored assets/skills directory.",
    );
  });
});
