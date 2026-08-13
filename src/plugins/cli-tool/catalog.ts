export interface CliToolBundleEntry {
  id: string;
  packageName: string;
  binaryName: string;
}

export const CLI_TOOL_BUNDLE: CliToolBundleEntry[] = [
  {
    id: "agnix",
    packageName: "agnix",
    binaryName: "agnix",
  },
];
