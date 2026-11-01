import type { ListItem, Paragraph, RootContent } from "mdast";
import { label, text } from "./markdown.js";

const RELEASE_HEADING_DEPTH = 2;
const CONVENTIONAL_PREFIX_PATTERN = /^(feat|fix)(?:\(([^)]+)\))?(!)?: /u;
const GROUP_FOR_TYPE: Record<string, string> = { feat: "Added", fix: "Fixed" };
const GROUP_ORDER = ["Added", "Changed", "Fixed"];
const OTHER_CHANGES = "Changed";

function splitIntoReleases(nodes: readonly RootContent[]): RootContent[][] {
  const releases: RootContent[][] = [];
  for (const node of nodes) {
    const startsRelease =
      node.type === "heading" && node.depth === RELEASE_HEADING_DEPTH;
    if (startsRelease || releases.length === 0) releases.push([]);
    releases[releases.length - 1].push(node);
  }
  return releases;
}

function flatListParagraphs(release: RootContent[]): Paragraph[] | null {
  const [heading, list, ...rest] = release;
  if (heading?.type !== "heading" || list?.type !== "list" || rest.length > 0) {
    return null;
  }
  const paragraphs: Paragraph[] = [];
  for (const item of list.children) {
    const [onlyChild, ...moreChildren] = item.children;
    if (onlyChild?.type !== "paragraph" || moreChildren.length > 0) return null;
    paragraphs.push(onlyChild);
  }
  return paragraphs;
}

function withGroup(paragraph: Paragraph): [string, Paragraph] {
  const [first, ...rest] = paragraph.children;
  if (first?.type !== "text") return [OTHER_CHANGES, paragraph];
  const match = CONVENTIONAL_PREFIX_PATTERN.exec(first.value);
  if (match === null) return [OTHER_CHANGES, paragraph];
  const [prefix, type, scope, breaking] = match;
  const lead = `${breaking ? "Breaking: " : ""}${scope ? `${scope}: ` : ""}`;
  return [
    GROUP_FOR_TYPE[type],
    {
      ...paragraph,
      children: [text(`${lead}${first.value.slice(prefix.length)}`), ...rest],
    },
  ];
}

function groupedRelease(
  heading: RootContent,
  paragraphs: Paragraph[],
): RootContent[] {
  const paragraphsByGroup = new Map<string, Paragraph[]>();
  for (const [group, paragraph] of paragraphs.map(withGroup)) {
    paragraphsByGroup.set(group, [
      ...(paragraphsByGroup.get(group) ?? []),
      paragraph,
    ]);
  }
  return [
    heading,
    ...GROUP_ORDER.flatMap((group): RootContent[] => {
      const grouped = paragraphsByGroup.get(group);
      if (grouped === undefined) return [];
      const items: ListItem[] = grouped.map((paragraph) => ({
        type: "listItem",
        spread: false,
        children: [paragraph],
      }));
      return [
        label(group),
        { type: "list", ordered: false, spread: false, children: items },
      ];
    }),
  ];
}

export function groupChangelogReleases(
  nodes: readonly RootContent[],
): RootContent[] {
  return splitIntoReleases(nodes).flatMap((release) => {
    const paragraphs = flatListParagraphs(release);
    return paragraphs === null
      ? release
      : groupedRelease(release[0], paragraphs);
  });
}
