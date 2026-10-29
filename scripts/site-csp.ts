import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { errorMessage } from "../src/core/error-message.js";
import {
  applyContentSecurityPolicy,
  findSvgProblems,
} from "./site-csp/policy.js";

const {
  positionals: [siteOrigin],
} = parseArgs({ allowPositionals: true });
const repositoryRoot = resolve(import.meta.dirname, "..");
const siteDirectory = join(repositoryRoot, "website", "dist");
const policy = readFileSync(
  join(repositoryRoot, "website", "csp-policy.txt"),
  "utf8",
).trim();

function filesUnder(directory: string, extension: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter((path) => path.toLowerCase().endsWith(extension))
    .map((path) => join(directory, path));
}

try {
  if (siteOrigin === undefined || new URL(siteOrigin).origin !== siteOrigin) {
    throw new Error(
      "usage: site-csp.ts <site origin, e.g. https://example.com>",
    );
  }
  const svgProblems = filesUnder(siteDirectory, ".svg").flatMap((path) =>
    findSvgProblems(readFileSync(path, "utf8"), relative(siteDirectory, path)),
  );
  if (svgProblems.length > 0) throw new Error(svgProblems.join("\n"));
  const pages = filesUnder(siteDirectory, ".html");
  for (const path of pages) {
    writeFileSync(
      path,
      applyContentSecurityPolicy(
        readFileSync(path, "utf8"),
        relative(siteDirectory, path),
        policy,
        siteOrigin,
      ),
    );
  }
  console.log(
    `site-csp: added a Content-Security-Policy to ${pages.length} pages`,
  );
} catch (error) {
  console.error(`site-csp: ${errorMessage(error)}`);
  process.exitCode = 1;
}
