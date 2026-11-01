import type { RootContent } from "mdast";
import {
  AGEMON_TOML_TABLES,
  CONFLICT_DECISIONS,
  type ConfigKey,
  validateConfigText,
} from "../../src/core/config.js";
import { errorMessage } from "../../src/core/error-message.js";
import { CORE_CAPABILITY_IDS } from "../../src/plugins/index.js";
import { SiteContentError } from "./error.js";
import { code, heading, paragraph, table, text, visit } from "./markdown.js";

const REQUIRED = "required";

const ALLOWED_VALUES: Record<string, readonly string[]> = {
  capabilities: CORE_CAPABILITY_IDS,
  known_capabilities: CORE_CAPABILITY_IDS,
  conflict_decisions: CONFLICT_DECISIONS,
};

const CONFIG_TABLES = Object.values(AGEMON_TOML_TABLES);

function assertAllowedValuesNameKnownKeys(): void {
  const keyNames = CONFIG_TABLES.flatMap((configTable) =>
    configTable.keys.map((key) => key.name),
  );
  const unknownKey = Object.keys(ALLOWED_VALUES).find(
    (name) => !keyNames.includes(name),
  );
  if (unknownKey !== undefined) {
    throw new SiteContentError(
      `the configuration page lists values for '${unknownKey}', which AGEMON_TOML_TABLES no longer has`,
    );
  }
}

function typeCell(key: ConfigKey): string {
  const values = ALLOWED_VALUES[key.name];
  return values === undefined ? key.type : `${key.type}: ${values.join(", ")}`;
}

function configurationReference(): RootContent[] {
  assertAllowedValuesNameKnownKeys();
  return CONFIG_TABLES.flatMap((configTable): RootContent[] => [
    heading(text(configTable.heading)),
    ...configTable.keys.flatMap((key): RootContent[] => [
      heading(code(key.name), 3),
      table(
        ["Type", "Default"],
        [[[text(typeCell(key))], [text(key.whenAbsent ?? REQUIRED)]]],
      ),
      paragraph(text(key.summary)),
    ]),
  ]);
}

function assertTomlExamplesParse(
  nodes: readonly RootContent[],
  sourcePath: string,
): void {
  for (const node of nodes) {
    visit(node, (child) => {
      if (child.type !== "code" || child.lang !== "toml") return;
      try {
        validateConfigText(child.value);
      } catch (error) {
        throw new SiteContentError(
          `${sourcePath}: a toml example is refused by agemon: ${errorMessage(error)}`,
        );
      }
    });
  }
}

export function configurationPageBody(
  readmeBody: RootContent[],
): RootContent[] {
  assertTomlExamplesParse(readmeBody, "README.md");
  return [...configurationReference(), ...readmeBody];
}
