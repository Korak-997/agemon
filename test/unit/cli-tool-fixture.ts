import {
  CLI_TOOL_BUNDLE,
  type CliToolBundleEntry,
} from "../../src/plugins/cli-tool/catalog.js";

const UNBUILT_TOOL_ID = "unbuilt-tool";

export function toolBuiltOnlyFor(platformKey: string): CliToolBundleEntry {
  const [agnix] = CLI_TOOL_BUNDLE;
  return {
    ...agnix,
    id: UNBUILT_TOOL_ID,
    binaryName: UNBUILT_TOOL_ID,
    releaseArchivesByPlatform: {
      [platformKey]: agnix.releaseArchivesByPlatform["linux-x64"],
    },
  };
}

export function linkedTool(): CliToolBundleEntry {
  const [agnix] = CLI_TOOL_BUNDLE;
  return {
    ...agnix,
    id: "linked-tool",
    binaryName: "linked-tool",
    install: { kind: "linked-binary" },
  };
}

export async function withOnlyTool<T>(
  tool: CliToolBundleEntry,
  body: () => Promise<T>,
): Promise<T> {
  const bundle = CLI_TOOL_BUNDLE.splice(0, CLI_TOOL_BUNDLE.length, tool);
  try {
    return await body();
  } finally {
    CLI_TOOL_BUNDLE.splice(0, CLI_TOOL_BUNDLE.length, ...bundle);
  }
}
