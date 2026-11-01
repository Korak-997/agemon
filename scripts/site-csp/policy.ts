import { createHash } from "node:crypto";
import { type DefaultTreeAdapterTypes, parse } from "parse5";

type Element = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;
type Template = DefaultTreeAdapterTypes.Template;

const SCRIPT_SRC_DIRECTIVE = "script-src 'self' 'wasm-unsafe-eval'";
const EXECUTABLE_SCRIPT_TYPES = ["", "module"];
const FORBIDDEN_ELEMENTS = ["base", "iframe", "object", "embed", "frame"];
const RESOURCE_ATTRIBUTES = [
  "src",
  "href",
  "xlink:href",
  "poster",
  "data",
  "action",
  "formaction",
];
const ELEMENTS_THAT_MAY_LINK_OFF_SITE = ["a", "link"];
const LINK_RELS_THAT_LOAD_RESOURCES = [
  "stylesheet",
  "preload",
  "modulepreload",
  "icon",
  "apple-touch-icon",
  "manifest",
  "prefetch",
  "dns-prefetch",
  "preconnect",
  "prerender",
];
// biome-ignore lint/suspicious/noControlCharactersInRegex: browsers drop these characters from URLs, so "java\tscript:" still runs
const URL_IGNORED_CHARACTERS_PATTERN = /[\u0000-\u0020]/gu;
const JAVASCRIPT_URL_PATTERN = /^javascript:/iu;
const OFF_SITE_STYLE_URL_PATTERN =
  /url\(\s*["']?\s*(?!data:)(?:[a-z][a-z0-9+.-]*:|\/\/)/iu;
const SVG_ACTIVE_CONTENT_PATTERN =
  /script|xmlns:|<foreignObject|<a[\s>]|<set[\s>]|<animate|\son[a-z]+\s*=|javascript:|@import|&|http-equiv|<meta|<form|<input|<iframe|<embed|<object|<link/iu;
// biome-ignore lint/suspicious/noControlCharactersInRegex: an ESC byte lets an SVG declared as ISO-2022-JP hide markup from these patterns
const SVG_ESCAPE_BYTE_PATTERN = /\u001b/u;
const SVG_NON_UTF8_ENCODING_PATTERN =
  /<\?xml[^>]*encoding\s*=\s*["'](?!utf-8["'])/iu;
const SVG_FOREIGN_NAMESPACE_PATTERN =
  /xmlns\s*=\s*["'](?!http:\/\/www\.w3\.org\/2000\/svg["'])/iu;
const SVG_EXTERNAL_REFERENCE_PATTERN =
  /(?:href\s*=\s*["']|url\(\s*["']?)(?:[a-z][a-z0-9+.-]*:|\/\/)/giu;

export class CspError extends Error {}

function withoutIgnoredUrlCharacters(url: string): string {
  return url.replace(URL_IGNORED_CHARACTERS_PATTERN, "");
}

function srcsetUrls(srcset: string): string[] {
  return srcset
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/u)[0]);
}

function isOffSite(url: string, siteOrigin: string): boolean {
  const trimmed = withoutIgnoredUrlCharacters(url);
  if (trimmed.startsWith("data:")) return false;
  if (!/^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(trimmed)) return false;
  try {
    return new URL(trimmed, siteOrigin).origin !== siteOrigin;
  } catch {
    return true;
  }
}

function attributeName(attr: Element["attrs"][number]): string {
  return attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name;
}

function attribute(element: Element, name: string): string | undefined {
  return element.attrs.find((attr) => attributeName(attr) === name)?.value;
}

function elementChildren(node: ParentNode): Element[] {
  return node.childNodes.filter(
    (child): child is Element => "tagName" in child,
  );
}

function scriptText(script: Element): string {
  return script.childNodes
    .map((child) =>
      child.nodeName === "#text" && "value" in child ? child.value : "",
    )
    .join("");
}

function checkElement(
  element: Element,
  siteOrigin: string,
  inlineScripts: string[],
  fail: (problem: string) => never,
): void {
  const tag = element.tagName;
  if (FORBIDDEN_ELEMENTS.includes(tag)) fail(`<${tag}> is not allowed`);
  if (
    tag === "meta" &&
    ["refresh", "content-security-policy"].includes(
      (attribute(element, "http-equiv") ?? "").toLowerCase(),
    )
  ) {
    fail(
      `<meta http-equiv="${attribute(element, "http-equiv")}"> is not allowed`,
    );
  }
  for (const attr of element.attrs) {
    const name = attributeName(attr);
    if (/^on/iu.test(attr.name))
      fail(`<${tag} ${name}> event handler attribute`);
    if (JAVASCRIPT_URL_PATTERN.test(withoutIgnoredUrlCharacters(attr.value))) {
      fail(`<${tag} ${name}> uses a javascript: URL`);
    }
    if (name === "style" && OFF_SITE_STYLE_URL_PATTERN.test(attr.value)) {
      fail(`<${tag} style> loads from another origin`);
    }
    const urls =
      name === "srcset"
        ? srcsetUrls(attr.value)
        : RESOURCE_ATTRIBUTES.includes(name)
          ? [attr.value]
          : [];
    const linksOffSite = urls.some((url) => isOffSite(url, siteOrigin));
    const mayLinkOffSite =
      ELEMENTS_THAT_MAY_LINK_OFF_SITE.includes(tag) &&
      !(
        tag === "link" &&
        (attribute(element, "rel") ?? "")
          .toLowerCase()
          .split(/\s+/u)
          .some((rel) => LINK_RELS_THAT_LOAD_RESOURCES.includes(rel))
      );
    if (linksOffSite && !mayLinkOffSite) {
      fail(`<${tag} ${name}="${attr.value}"> loads from another origin`);
    }
  }
  if (tag === "script") {
    const type = (attribute(element, "type") ?? "").trim().toLowerCase();
    if (!EXECUTABLE_SCRIPT_TYPES.includes(type)) {
      fail(`<script type="${type}"> is not an allowed script type`);
    }
    if (attribute(element, "src") === undefined) {
      inlineScripts.push(scriptText(element));
    }
  }
}

function walk(
  node: ParentNode,
  visitElement: (element: Element) => void,
): void {
  for (const child of elementChildren(node)) {
    visitElement(child);
    walk(
      child.tagName === "template" ? (child as Template).content : child,
      visitElement,
    );
  }
}

function sha256Source(text: string): string {
  return `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
}

export function applyContentSecurityPolicy(
  html: string,
  pagePath: string,
  policy: string,
  siteOrigin: string,
): string {
  const fail = (problem: string): never => {
    throw new CspError(`${pagePath}: ${problem}`);
  };
  if (!policy.includes(SCRIPT_SRC_DIRECTIVE)) {
    fail(`the CSP policy must contain "${SCRIPT_SRC_DIRECTIVE}"`);
  }
  const document = parse(html, {
    sourceCodeLocationInfo: true,
    scriptingEnabled: false,
  });
  const inlineScripts: string[] = [];
  walk(document, (element) =>
    checkElement(element, siteOrigin, inlineScripts, fail),
  );
  const head = elementChildren(
    elementChildren(document).find((element) => element.tagName === "html") ??
      fail("has no <html> element"),
  ).find((element) => element.tagName === "head");
  const headStartTagEnd = head?.sourceCodeLocation?.startTag?.endOffset;
  if (headStartTagEnd === undefined) fail("has no <head> start tag");
  const hashes = [...new Set(inlineScripts.map(sha256Source))];
  const pagePolicy = policy.replace(
    SCRIPT_SRC_DIRECTIVE,
    [SCRIPT_SRC_DIRECTIVE, ...hashes].join(" "),
  );
  const meta = `<meta http-equiv="content-security-policy" content="${pagePolicy}">`;
  return `${html.slice(0, headStartTagEnd)}${meta}${html.slice(headStartTagEnd)}`;
}

export function findSvgProblems(svg: string, svgPath: string): string[] {
  const problems: string[] = [];
  if (SVG_ESCAPE_BYTE_PATTERN.test(svg)) {
    problems.push(`${svgPath}: contains an ESC byte`);
  }
  if (SVG_NON_UTF8_ENCODING_PATTERN.test(svg)) {
    problems.push(`${svgPath}: declares an encoding other than UTF-8`);
  }
  const activeContent = SVG_ACTIVE_CONTENT_PATTERN.exec(svg);
  if (activeContent) {
    problems.push(
      `${svgPath}: contains active content (${activeContent[0].trim()})`,
    );
  }
  if (SVG_FOREIGN_NAMESPACE_PATTERN.test(svg)) {
    problems.push(`${svgPath}: declares a namespace other than SVG`);
  }
  for (const reference of svg.matchAll(SVG_EXTERNAL_REFERENCE_PATTERN)) {
    problems.push(`${svgPath}: references another resource (${reference[0]})`);
  }
  return problems;
}
