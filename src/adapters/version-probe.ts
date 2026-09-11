import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { Context } from "../core/context.js";
import type { AgentInstallationEvidence } from "./types.js";

const SEMVER_PATTERN = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/;

export function extractSemverVersion(stdout: string): string | null {
  return SEMVER_PATTERN.exec(stdout)?.[0] ?? null;
}
export async function resolveExecutableAbsolutePath(
  binaryName: string,
  pathEnv: string,
): Promise<string | undefined> {
  for (const pathEntry of pathEnv.split(delimiter)) {
    if (!pathEntry) {
      continue;
    }

    const binaryPath = join(pathEntry, binaryName);
    try {
      await access(binaryPath, constants.X_OK);
      return binaryPath;
    } catch {}
  }

  return undefined;
}

export interface VersionProbeSpec {
  binaryName: string;
  versionArgs: string[];
  parseVersion: (stdout: string) => string | null;
  timeoutMs: number;
}

function notInstalledEvidence(): AgentInstallationEvidence {
  return {
    level: "configured",
    executablePath: null,
    version: null,
    evidence: [],
  };
}

export async function probeAgentInstallation(
  ctx: Context,
  spec: VersionProbeSpec,
): Promise<AgentInstallationEvidence> {
  const executablePath = await resolveExecutableAbsolutePath(
    spec.binaryName,
    process.env.PATH ?? "",
  );
  if (!executablePath) {
    return notInstalledEvidence();
  }

  const result = await ctx.run(executablePath, spec.versionArgs, {
    timeoutMs: spec.timeoutMs,
  });
  const version = result.code === 0 ? spec.parseVersion(result.stdout) : null;

  return {
    level: version ? "installed" : "configured",
    executablePath,
    version,
    evidence: [
      `resolved ${spec.binaryName} at ${executablePath}`,
      version
        ? `reported version ${version}`
        : `probe failed: exit ${result.code}`,
    ],
  };
}

export interface UsabilityProbeSpec {
  usabilityArgs: string[];
  timeoutMs: number;
}

export async function probeAgentUsability(
  ctx: Context,
  installation: AgentInstallationEvidence,
  spec: UsabilityProbeSpec,
): Promise<AgentInstallationEvidence> {
  if (installation.level !== "installed" || !installation.executablePath) {
    return installation;
  }

  const command = [installation.executablePath, ...spec.usabilityArgs].join(
    " ",
  );
  const result = await ctx.run(
    installation.executablePath,
    spec.usabilityArgs,
    {
      timeoutMs: spec.timeoutMs,
    },
  );

  if (result.code !== 0) {
    return {
      ...installation,
      evidence: [
        ...installation.evidence,
        `usability probe failed: ${command} exited ${result.code}`,
      ],
    };
  }

  return {
    ...installation,
    level: "usable",
    evidence: [
      ...installation.evidence,
      `usability probe succeeded: ${command}`,
    ],
  };
}
