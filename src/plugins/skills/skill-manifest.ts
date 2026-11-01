import { printable } from "../../core/untrusted-text.js";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;
const NAME_LINE_PATTERN = /^name:[ \t]*(["']?)(.*?)\1[ \t]*$/gmu;

export function skillFrontmatter(manifest: string): string | undefined {
  return FRONTMATTER_PATTERN.exec(manifest)?.[1];
}

export function declaredSkillName(manifest: string): string | null {
  const frontmatter = skillFrontmatter(manifest);
  const nameLines =
    frontmatter === undefined
      ? []
      : [...frontmatter.matchAll(NAME_LINE_PATTERN)];
  return nameLines.length === 1 ? nameLines[0][2] : null;
}

export function assertSkillManifestName(
  manifest: string,
  expectedName: string,
  sourceLabel: string,
): void {
  const declaredName = declaredSkillName(manifest);
  if (declaredName !== expectedName) {
    throw new Error(
      `Refusing to install the custom skill ${printable(sourceLabel)}: its SKILL.md names it '${printable(declaredName ?? "(no single name)")}', but agemon.toml expects '${expectedName}'. Make them match.`,
    );
  }
}
