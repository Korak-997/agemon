export interface RunFlags {
  dryRun: boolean;
  real: boolean;
  trace: boolean;
  quiet: boolean;
  skipDaemon: boolean;
  only?: string;
  skillGroups?: string;
  label?: string;
}

export function buildAgemonArgv(flags: RunFlags): string[] {
  const argv: string[] = [];
  if (flags.dryRun) argv.push("--dry-run");
  if (flags.skipDaemon) argv.push("--skip-daemon");
  if (flags.only) argv.push("--only", flags.only);
  if (flags.skillGroups) argv.push("--skill-groups", flags.skillGroups);
  if (flags.quiet) argv.push("--quiet");
  if (flags.trace) argv.push("--verbose");
  return argv;
}

export function buildRunArgv(flags: RunFlags): string[] {
  const appliesWithoutAsking = !flags.dryRun && !flags.real;
  return [
    ...(appliesWithoutAsking ? ["--yes"] : []),
    ...buildAgemonArgv(flags),
  ];
}
