import type { Root, RootContent } from "mdast";
import { serializeMarkdown } from "./markdown.js";

export interface GeneratedPage {
  path: string;
  title: string;
  description: string;
  sidebarOrder: number;
  body: RootContent[];
}

export function renderPage(page: GeneratedPage): string {
  const frontmatter = [
    "---",
    `title: ${JSON.stringify(page.title)}`,
    `description: ${JSON.stringify(page.description)}`,
    "sidebar:",
    `  order: ${page.sidebarOrder}`,
    "---",
  ].join("\n");
  const root: Root = { type: "root", children: page.body };
  return `${frontmatter}\n\n${serializeMarkdown(root)}`;
}
