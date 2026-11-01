import { posix } from "node:path";
import GithubSlugger from "github-slugger";
import type {
  Heading,
  Nodes,
  PhrasingContent,
  Root,
  RootContent,
  Table,
  TableCell,
  TableRow,
} from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown, gfmToMarkdown } from "mdast-util-gfm";
import { toMarkdown } from "mdast-util-to-markdown";
import { gfm } from "micromark-extension-gfm";
import { GITHUB_REPOSITORY } from "../../src/core/github-release.js";
import { SiteContentError } from "./error.js";

const REPOSITORY_BLOB_URL = `https://github.com/${GITHUB_REPOSITORY}/blob`;
const URL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/iu;
const ALLOWED_URL_SCHEMES = ["https:", "mailto:"];
const DIRECTIVE_SYNTAX_PATTERN = /(?:^|[^\w:]):{1,3}[a-z]/imu;
const FORBIDDEN_NODE_TYPES: Record<string, string> = {
  html: "raw HTML",
  image: "an image",
  imageReference: "an image",
};

export const text = (value: string): PhrasingContent => ({
  type: "text",
  value,
});

export const code = (value: string): PhrasingContent => ({
  type: "inlineCode",
  value,
});

export const paragraph = (...children: PhrasingContent[]): RootContent => ({
  type: "paragraph",
  children,
});

export const heading = (
  content: PhrasingContent,
  depth: Heading["depth"] = 2,
): RootContent => ({
  type: "heading",
  depth,
  children: [content],
});

export const label = (value: string): RootContent => ({
  type: "paragraph",
  children: [{ type: "strong", children: [text(value)] }],
});

export function table(header: string[], rows: PhrasingContent[][][]): Table {
  const row = (cells: PhrasingContent[][]): TableRow => ({
    type: "tableRow",
    children: cells.map(
      (children): TableCell => ({ type: "tableCell", children }),
    ),
  });
  return {
    type: "table",
    children: [
      row(header.map((headerText) => [text(headerText)])),
      ...rows.map(row),
    ],
  };
}

export function parseMarkdown(text: string): Root {
  const root = fromMarkdown(text, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  return root;
}

export function serializeMarkdown(root: Root): string {
  return toMarkdown(root, { extensions: [gfmToMarkdown()] });
}

export function visit(node: Nodes, onNode: (node: Nodes) => void): void {
  onNode(node);
  if ("children" in node) {
    for (const child of node.children) visit(child, onNode);
  }
}

export function assertPublishable(
  nodes: readonly RootContent[],
  sourcePath: string,
): void {
  for (const node of nodes)
    visit(node, (child) => assertPublishableNode(child, sourcePath));
}

function assertPublishableNode(node: Nodes, sourcePath: string): void {
  const forbidden = FORBIDDEN_NODE_TYPES[node.type];
  if (forbidden) {
    throw new SiteContentError(
      `${sourcePath}:${node.position?.start.line}: contains ${forbidden}; the website does not publish ${forbidden} from repository Markdown`,
    );
  }
  if (node.type === "text" && DIRECTIVE_SYNTAX_PATTERN.test(node.value)) {
    throw new SiteContentError(
      `${sourcePath}:${node.position?.start.line}: text looks like a Markdown directive (${JSON.stringify(node.value)}); reword it or put it in code`,
    );
  }
}

export function plainText(node: Nodes): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value;
  if ("children" in node) return node.children.map(plainText).join("");
  return "";
}

export function headingSlugs(
  nodes: readonly RootContent[],
): Map<Heading, string> {
  const slugger = new GithubSlugger();
  const slugs = new Map<Heading, string>();
  for (const node of nodes) {
    visit(node, (child) => {
      if (child.type === "heading") {
        slugs.set(child, slugger.slug(plainText(child)));
      }
    });
  }
  return slugs;
}

export function extractSection(
  root: Root,
  headingText: string,
  sourcePath: string,
): RootContent[] {
  const start = root.children.findIndex(
    (node) => node.type === "heading" && plainText(node) === headingText,
  );
  if (start === -1) {
    throw new SiteContentError(
      `${sourcePath}: has no heading "${headingText}"; the website imports that section`,
    );
  }
  const depth = (root.children[start] as Heading).depth;
  const end = root.children.findIndex(
    (node, index) =>
      index > start && node.type === "heading" && node.depth <= depth,
  );
  return root.children.slice(start, end === -1 ? undefined : end);
}

export function withoutLeadingTitle(root: Root): RootContent[] {
  const [first, ...rest] = root.children;
  return first?.type === "heading" && first.depth === 1 ? rest : root.children;
}

export function shiftHeadingsToStartAtLevelTwo(nodes: RootContent[]): void {
  const headings = nodes.filter(
    (node): node is Heading => node.type === "heading",
  );
  if (headings.length === 0) return;
  const shift = 2 - Math.min(...headings.map((heading) => heading.depth));
  for (const heading of headings) {
    heading.depth = Math.min(6, heading.depth + shift) as Heading["depth"];
  }
}

export interface LinkTargets {
  routeForFile: ReadonlyMap<string, string>;
  routeForReadmeAnchor: ReadonlyMap<string, string>;
  repositoryRef: string;
}

function rewriteUrl(
  url: string,
  sourcePath: string,
  targets: LinkTargets,
): string {
  if (URL_SCHEME_PATTERN.test(url)) {
    const scheme = url.slice(0, url.indexOf(":") + 1).toLowerCase();
    if (!ALLOWED_URL_SCHEMES.includes(scheme)) {
      throw new SiteContentError(
        `${sourcePath}: link ${JSON.stringify(url)} uses ${scheme}; only https: and mailto: links are published`,
      );
    }
    return url;
  }
  if (url.startsWith("//")) {
    throw new SiteContentError(
      `${sourcePath}: protocol-relative link ${JSON.stringify(url)} is not published; write https://`,
    );
  }
  const [pathPart, anchor] = url.split("#", 2);
  const targetPath = pathPart
    ? posix.normalize(
        pathPart.startsWith("/")
          ? pathPart.slice(1)
          : posix.join(posix.dirname(sourcePath), pathPart),
      )
    : sourcePath;
  if (targetPath.startsWith("..")) {
    throw new SiteContentError(
      `${sourcePath}: link ${JSON.stringify(url)} points outside the repository`,
    );
  }
  if (targetPath === "README.md" && anchor) {
    const readmeRoute = targets.routeForReadmeAnchor.get(anchor);
    if (readmeRoute) return readmeRoute;
  }
  const route = targets.routeForFile.get(targetPath);
  if (route) return anchor ? `${route}#${anchor}` : route;
  const fragment = anchor ? `#${anchor}` : "";
  return `${REPOSITORY_BLOB_URL}/${targets.repositoryRef}/${targetPath}${fragment}`;
}

export function rewriteLinks(
  nodes: readonly RootContent[],
  sourcePath: string,
  targets: LinkTargets,
): void {
  for (const node of nodes) {
    visit(node, (child) => {
      if (child.type === "link" || child.type === "definition") {
        child.url = rewriteUrl(child.url, sourcePath, targets);
      }
    });
  }
}
