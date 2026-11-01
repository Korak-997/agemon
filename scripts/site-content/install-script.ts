import { createHash } from "node:crypto";
import { SiteContentError } from "./error.js";

const INSTALL_SCRIPT_CHECKSUM_LINE = /^([0-9a-f]{64}) {2}install\.sh$/u;

export interface InstallScriptChecksum {
  sha256: string;
  source: "release" | "working-tree";
}

function sha256Of(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

export function checksumInstallScript(
  installScript: Buffer,
  sha256Sums?: string,
): InstallScriptChecksum {
  const sha256 = sha256Of(installScript);
  if (sha256Sums === undefined) {
    return { sha256, source: "working-tree" };
  }
  const listed = sha256Sums
    .split(/\r?\n/u)
    .flatMap((line) => INSTALL_SCRIPT_CHECKSUM_LINE.exec(line)?.[1] ?? []);
  if (listed.length !== 1) {
    throw new SiteContentError(
      `SHA256SUMS must list install.sh exactly once (found ${listed.length})`,
    );
  }
  if (listed[0] !== sha256) {
    throw new SiteContentError(
      `install.sh does not match SHA256SUMS (expected ${listed[0]}, got ${sha256})`,
    );
  }
  return { sha256, source: "release" };
}
