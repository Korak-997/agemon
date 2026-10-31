import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RECORDINGS } from "../../../website/src/recordings.js";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");
const RECORDINGS_DIRECTORY = "website/recordings";
const MEDIA_DIRECTORY = "website/public/media";
const RECORDED_LEDGER = "website/src/data/recorded-ledger.json";
const MAX_VIDEO_BYTES = 3 * 1024 * 1024;
const MAX_POSTER_BYTES = 512 * 1024;
const RECORDING_INPUTS = ["Dockerfile", "record.sh", "settings.tape"];

function repositoryFile(path: string): Buffer {
  return readFileSync(join(REPOSITORY_ROOT, path));
}

function manifestEntries(): Map<string, string> {
  const lines = repositoryFile(`${RECORDINGS_DIRECTORY}/recordings.sha256`)
    .toString("utf8")
    .trim()
    .split("\n");
  return new Map(
    lines.map((line) => {
      const [sha256, path] = line.split("  ");
      return [path, sha256];
    }),
  );
}

function tapeOutputs(tape: string): string[] {
  return [
    ...repositoryFile(`${RECORDINGS_DIRECTORY}/${tape}`)
      .toString("utf8")
      .matchAll(/^(?:Output|Screenshot) (\S+)$/gmu),
  ].map((match) => match[1]);
}

describe("website recordings", () => {
  it("lists every recording input and output in recordings.sha256, with matching hashes", () => {
    const expectedPaths = [
      ...RECORDING_INPUTS.map((input) => `${RECORDINGS_DIRECTORY}/${input}`),
      ...RECORDINGS.map(({ name }) => `${RECORDINGS_DIRECTORY}/${name}.tape`),
      ...RECORDINGS.flatMap(({ name }) => [
        `${MEDIA_DIRECTORY}/${name}.webm`,
        `${MEDIA_DIRECTORY}/${name}.png`,
      ]),
      RECORDED_LEDGER,
    ];
    const entries = manifestEntries();

    expect([...entries.keys()].sort()).toEqual([...expectedPaths].sort());
    for (const [path, sha256] of entries) {
      expect(
        createHash("sha256").update(repositoryFile(path)).digest("hex"),
        `${path} changed without re-recording (website/recordings/README.md)`,
      ).toBe(sha256);
    }
  });

  it("has one tape per recording, writing exactly the media the site shows", () => {
    const tapes = readdirSync(join(REPOSITORY_ROOT, RECORDINGS_DIRECTORY))
      .filter((file) => file.endsWith(".tape") && file !== "settings.tape")
      .sort();

    expect(tapes).toEqual(RECORDINGS.map(({ name }) => `${name}.tape`).sort());
    for (const { name } of RECORDINGS) {
      expect(tapeOutputs(`${name}.tape`)).toEqual([
        `${name}.webm`,
        `${name}.png`,
      ]);
      expect(readdirSync(join(REPOSITORY_ROOT, MEDIA_DIRECTORY))).toEqual(
        expect.arrayContaining([`${name}.webm`, `${name}.png`]),
      );
    }
  });

  it("keeps each video under 3 MiB and each poster under 512 KiB", () => {
    for (const { name } of RECORDINGS) {
      const media = (extension: string) =>
        statSync(join(REPOSITORY_ROOT, MEDIA_DIRECTORY, `${name}.${extension}`))
          .size;
      expect(media("webm"), `${name}.webm`).toBeLessThanOrEqual(
        MAX_VIDEO_BYTES,
      );
      expect(media("png"), `${name}.png`).toBeLessThanOrEqual(MAX_POSTER_BYTES);
    }
  });
});
