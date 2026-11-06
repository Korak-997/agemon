#!/usr/bin/env node

// Read-only design asset inventory. Usage: node inventory.mjs [root]
// Prints JSON to stdout and writes nothing. Only typed values leave this file
// (colour, dimension, font name, path), because the repo it reads is untrusted.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const MAX_FILES = 5000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_VALUE_LENGTH = 120;
const MAX_FONT_WORDS = 5;
const MAX_FRONT_MATTER_LINE_LENGTH = 300;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_TOKENS = 2000;
const MAX_LISTED_ITEMS = 100;
const MAX_CSS_DEPTH = 64;
const MAX_PATH_SPACES = 3;
const MAX_PATH_SEGMENT_LENGTH = 64;
const TOP_FREQUENCIES = 20;
const EXIT_BAD_ROOT = 2;

const SKIPPED_DIRECTORIES = new Set([
  "node_modules", "dist", "build", "out", "coverage", "vendor", "storybook-static",
]);
const READABLE_HIDDEN_DIRECTORIES = new Set([".ui-craft"]);

const SAFE_PATH = /^[\p{L}\p{N}_ ./@()+[\]-]{1,200}$/u;
const SAFE_NAME = /^[A-Za-z-][\w-]{0,63}$/;
const STYLE_FILE = /\.(?:css|scss|pcss)$/;
const MINIFIED_FILE = /\.min\.[a-z]+$/;
const BUILT_STYLE_FILE = /(?:^|\/)(?:output|compiled|bundle|generated)[^/]*\.css$/;
const TAILWIND_BUILD_HEADER = /^\s*\/\*!?\s*!?\s*tailwindcss v\d/;
const TAILWIND_COMPILED_THEME = /@layer theme\s*\{\s*:root,\s*:host/;
const CODE_FILE = /\.(?:tsx?|jsx?|mjs|cjs|html|vue|svelte|astro|mdx)$/;
const TAILWIND_CONFIG_FILE = /(?:^|\/)tailwind\.config\.(?:js|cjs|mjs|ts|cts|mts)$/;
const DESIGN_CONTRACT_FILE = /^(?:DESIGN|design)\.md$/;
const CONTRACT_FILE =
  /^(?:(?:DESIGN|design|PRODUCT|BRAND)\.md|\.ui-craft\/(?:brief|tokens)\.md|docs\/brand[^/]*|(?:.*\/)?design-tokens\.json|(?:.*\/)?[^/]+\.tokens(?:\.json)?)$/;
const LOGO_FILE =
  /(?:^|[/_. -])(?:logo|logomark|wordmark|brandmark)[^/]*\.(?:svg|png|webp|jpe?g|ico|avif)$/i;

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/;
const COLOR_FUNCTION =
  /^(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)\((?:[\d.,%\s/+-]|none|deg|rad|turn|srgb|display-p3)+\)$/;
const HSL_CHANNELS = /^\d+(?:\.\d+)?\s+\d+(?:\.\d+)?%\s+\d+(?:\.\d+)?%$/;
const DIMENSION =
  /^(?:0|-?(?:\d+\.?\d*|\.\d+)(?:px|rem|em|ch|ex|vh|vw|svh|dvh|lvh|vmin|vmax|%))$/;
const FONT_NAME = /^[A-Za-z][A-Za-z0-9 -]{0,47}$/;
const FONT_TOKEN_NAME = /font(?![-_]?(?:size|weight|style|stretch|feature|variation))/i;
const GENERIC_FONT =
  /^(?:serif|sans-serif|monospace|cursive|fantasy|math|emoji|fangsong|inherit|initial|unset|revert|none|system-ui|ui-[a-z-]+|-apple-system|BlinkMacSystemFont)$/i;

// The lookbehinds keep fragment links out: href="#add" is not a colour.
const HEX_IN_TEXT = /(?<![\w&/])(?<!href=["'])#[0-9a-fA-F]{3,8}\b/g;
const COLOR_FUNCTION_IN_TEXT = /\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)\([^()]{1,80}\)/gi;
const ROUNDED_CLASS = /\brounded-(none|xs|sm|md|lg|xl|2xl|3xl|full)\b/g;
const ROUNDED_ARBITRARY_CLASS = /\brounded-\[([^\]\s]{1,40})\]/g;
const JS_BORDER_RADIUS = /\bborderRadius:\s*["'`]([^"'`\n]{1,40})["'`]/g;
const NEXT_FONT_IMPORT = /import\s*\{([^}]{1,300})\}\s*from\s*["']next\/font\/google["']/g;
const FONTSOURCE_IMPORT = /@fontsource(?:-variable)?\/([a-z0-9-]{1,60})/g;
const GOOGLE_FONTS_URL = /fonts\.googleapis\.com\/css2?\?[^"'\s)]{1,500}/g;
const GOOGLE_FONT_FAMILY = /family=([^&:;]+)/g;
const CONFIG_STRING_ENTRY = /(?<![\w-])(["']?)([A-Za-z][\w-]{0,63})\1\s*:\s*["']([^"'\n]{1,120})["']/g;
const CONFIG_FONT_BLOCK = /fontFamily\s*:\s*\{([^}]{0,1000})\}/g;
const CONFIG_FONT_ENTRY = /(?<![\w-])(["']?)([A-Za-z][\w-]{0,63})\1\s*:\s*\[?\s*["']([^"'\n]{1,120})["']/g;
const FRONT_MATTER_ENTRY = /^( *)["']?([^"':\n]+?)["']?\s*:\s*(.*)$/;
const BASE_THEME_SELECTOR = String.raw`(?::root|:host|html|\.light)(?:\[data-theme=["']?light["']?\])?`;
const TOKEN_BLOCK_SELECTOR = new RegExp(`^${BASE_THEME_SELECTOR}(?:\\s*,\\s*${BASE_THEME_SELECTOR})*$`);
const CONFIG_COMMENT = /^\s*\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm;
const BASE_COLOR_NAME = /^[a-z]{1,16}$/;
const PACKAGE_SCOPE = /^(?:apps|packages)\/[^/]+/;
const CONTRACT_TOKEN_SECTIONS = new Set(["colors", "typography", "rounded", "spacing"]);

const FRAMEWORK_PACKAGES = [
  "next", "react", "vue", "nuxt", "svelte", "@sveltejs/kit", "astro", "solid-js",
];
const STYLING_PACKAGES = [
  "styled-components", "@emotion/react", "@vanilla-extract/css", "@stitches/react",
  "@mui/material", "@chakra-ui/react", "@mantine/core", "antd",
];

// Values from shadcn/ui registry base colours (MIT) and create-next-app, as recorded in the
// skill's licence record. Stock values are not a brand, however many of them a repo declares.
const STOCK_TOKEN_VALUES = new Set([
  "0 0% 100%", "0 0% 14.9%", "0 0% 3.9%", "0 0% 45.1%", "0 0% 63.9%", "0 0% 83.1%", "0 0% 89.8%",
  "0 0% 9%", "0 0% 96.1%", "0 0% 98%", "0 62.8% 30.6%", "0 84.2% 60.2%", "12 6.5% 15.1%",
  "12 76% 61%", "160 60% 45%", "173 58% 39%", "197 37% 24%", "20 14.3% 4.1%", "20 5.9% 90%",
  "210 20% 98%", "210 40% 96.1%", "210 40% 98%", "212.7 26.8% 83.9%", "214.3 31.8% 91.4%",
  "215 20.2% 65.1%", "215 27.9% 16.9%", "215.4 16.3% 46.9%", "216 12.2% 83.9%",
  "217.2 32.6% 17.5%", "217.2 91.2% 59.8%", "217.9 10.6% 64.9%", "220 13% 91%", "220 14.3% 95.9%",
  "220 70% 50%", "220 8.9% 46.1%", "220.9 39.3% 11%", "222.2 47.4% 11.2%", "222.2 84% 4.9%",
  "224 71.4% 4.1%", "224.3 76.3% 48%", "24 5.4% 63.9%", "24 5.7% 82.9%", "24 9.8% 10%",
  "240 10% 3.9%", "240 3.7% 15.9%", "240 3.8% 46.1%", "240 4.8% 95.9%", "240 4.9% 83.9%",
  "240 5% 64.9%", "240 5.3% 26.1%", "240 5.9% 10%", "240 5.9% 90%", "25 5.3% 44.7%", "27 87% 67%",
  "280 65% 60%", "30 80% 55%", "340 75% 55%", "43 74% 66%", "60 4.8% 95.9%", "60 9.1% 97.8%",
  "oklch(0.129 0.042 264.695)", "oklch(0.13 0.028 261.692)", "oklch(0.141 0.005 285.823)",
  "oklch(0.145 0 0)", "oklch(0.145 0.008 326)", "oklch(0.147 0.004 49.25)",
  "oklch(0.147 0.004 49.3)", "oklch(0.148 0.004 228.8)", "oklch(0.153 0.006 107.1)",
  "oklch(0.205 0 0)", "oklch(0.208 0.042 265.755)", "oklch(0.21 0.006 285.885)",
  "oklch(0.21 0.034 264.665)", "oklch(0.212 0.019 322.12)", "oklch(0.214 0.009 43.1)",
  "oklch(0.216 0.006 56.043)", "oklch(0.218 0.008 223.9)", "oklch(0.228 0.013 107.4)",
  "oklch(0.263 0.024 320.12)", "oklch(0.268 0.007 34.298)", "oklch(0.268 0.011 36.5)",
  "oklch(0.269 0 0)", "oklch(0.274 0.006 286.033)", "oklch(0.275 0.011 216.9)",
  "oklch(0.278 0.033 256.848)", "oklch(0.279 0.041 260.031)", "oklch(0.286 0.016 107.4)",
  "oklch(0.364 0.029 323.89)", "oklch(0.367 0.016 35.7)", "oklch(0.37 0.013 285.805)",
  "oklch(0.371 0 0)", "oklch(0.374 0.01 67.558)", "oklch(0.378 0.015 216)",
  "oklch(0.394 0.023 107.4)", "oklch(0.398 0.07 227.392)", "oklch(0.435 0.029 321.78)",
  "oklch(0.438 0.017 39.3)", "oklch(0.439 0 0)", "oklch(0.442 0.017 285.786)",
  "oklch(0.444 0.011 73.639)", "oklch(0.45 0.017 213.2)", "oklch(0.466 0.025 107.3)",
  "oklch(0.488 0.243 264.376)", "oklch(0.542 0.034 322.5)", "oklch(0.547 0.021 43.1)",
  "oklch(0.551 0.027 264.364)", "oklch(0.552 0.016 285.938)", "oklch(0.553 0.013 58.071)",
  "oklch(0.554 0.046 257.417)", "oklch(0.556 0 0)", "oklch(0.56 0.021 213.5)",
  "oklch(0.577 0.245 27.325)", "oklch(0.58 0.031 107.3)", "oklch(0.6 0.118 184.704)",
  "oklch(0.627 0.265 303.9)", "oklch(0.645 0.246 16.439)", "oklch(0.646 0.222 41.116)",
  "oklch(0.696 0.17 162.48)", "oklch(0.704 0.04 256.788)", "oklch(0.704 0.191 22.216)",
  "oklch(0.705 0.015 286.067)", "oklch(0.707 0.022 261.325)", "oklch(0.708 0 0)",
  "oklch(0.709 0.01 56.259)", "oklch(0.711 0.019 323.02)", "oklch(0.714 0.014 41.2)",
  "oklch(0.723 0.014 214.4)", "oklch(0.737 0.021 106.9)", "oklch(0.769 0.188 70.08)",
  "oklch(0.828 0.189 84.429)", "oklch(0.865 0.012 325.68)", "oklch(0.868 0.007 39.5)",
  "oklch(0.869 0.005 56.366)", "oklch(0.87 0 0)", "oklch(0.871 0.006 286.286)",
  "oklch(0.872 0.007 219.6)", "oklch(0.88 0.011 106.6)", "oklch(0.92 0.004 286.32)",
  "oklch(0.922 0 0)", "oklch(0.922 0.005 325.62)", "oklch(0.922 0.005 34.3)",
  "oklch(0.923 0.003 48.717)", "oklch(0.925 0.005 214.3)", "oklch(0.928 0.006 264.531)",
  "oklch(0.929 0.013 255.508)", "oklch(0.93 0.007 106.5)", "oklch(0.96 0.002 17.2)",
  "oklch(0.96 0.003 325.6)", "oklch(0.963 0.002 197.1)", "oklch(0.966 0.005 106.5)",
  "oklch(0.967 0.001 286.375)", "oklch(0.967 0.003 264.542)", "oklch(0.968 0.007 247.896)",
  "oklch(0.97 0 0)", "oklch(0.97 0.001 106.424)", "oklch(0.984 0.003 247.858)", "oklch(0.985 0 0)",
  "oklch(0.985 0.001 106.423)", "oklch(0.985 0.002 247.839)", "oklch(0.986 0.002 67.8)",
  "oklch(0.987 0.002 197.1)", "oklch(0.988 0.003 106.5)", "oklch(1 0 0 / 10%)",
  "oklch(1 0 0 / 15%)", "oklch(1 0 0)", "#ffffff", "#171717", "#0a0a0a", "#ededed", "Geist",
  "Geist Mono", "Inter",
]);

function collectFiles(root) {
  const files = [];
  const queue = [""];
  let truncated = false;
  let unread = 0;
  while (queue.length > 0 && !truncated) {
    const directory = queue.shift();
    let entries;
    try {
      entries = readdirSync(join(root, directory), { withFileTypes: true });
    } catch {
      unread += 1;
      continue;
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : 1));
    for (const entry of entries) {
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (!isSafePath(path)) {
        unread += 1;
      } else if (entry.isDirectory()) {
        if (isScannedDirectory(entry.name)) queue.push(path);
      } else if (entry.isFile()) {
        if (files.length === MAX_FILES) {
          truncated = true;
          break;
        }
        files.push(path);
      }
    }
  }
  return { files, truncated, unread };
}

function isSafePath(path) {
  return (
    SAFE_PATH.test(path) &&
    path.split(" ").length - 1 <= MAX_PATH_SPACES &&
    path.split("/").every((segment) => segment.length <= MAX_PATH_SEGMENT_LENGTH)
  );
}

function isScannedDirectory(name) {
  if (name.startsWith(".")) return READABLE_HIDDEN_DIRECTORIES.has(name);
  return !SKIPPED_DIRECTORIES.has(name);
}

function colorValue(raw) {
  const value = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (value.length > MAX_VALUE_LENGTH) return null;
  if (HEX_COLOR.test(value)) return expandShortHex(value);
  return COLOR_FUNCTION.test(value) || HSL_CHANNELS.test(value) ? value : null;
}

function expandShortHex(hex) {
  if (hex.length > 5) return hex;
  return `#${[...hex.slice(1)].map((digit) => digit + digit).join("")}`;
}

function dimensionValue(raw) {
  const value = raw.trim().toLowerCase();
  return DIMENSION.test(value) ? value : null;
}

function fontName(raw) {
  const name = raw.trim().replace(/^["']|["']$/g, "").trim();
  if (!FONT_NAME.test(name) || GENERIC_FONT.test(name)) return null;
  return name.split(/[\s-]+/).length <= MAX_FONT_WORDS ? name : null;
}

function firstFontInStack(stack) {
  return stack.length > MAX_VALUE_LENGTH ? null : fontName(stack.split(",")[0]);
}

function typedTokenValue(name, raw) {
  const color = colorValue(raw);
  if (color) return { value: color, kind: "color" };
  const dimension = dimensionValue(raw);
  if (dimension) return { value: dimension, kind: "dimension" };
  if (!FONT_TOKEN_NAME.test(name)) return null;
  const font = firstFontInStack(raw);
  return font ? { value: font, kind: "font" } : null;
}

function parseCssStatements(text, hasLineComments) {
  const statements = [];
  const enclosingBlocks = [];
  let buffer = "";
  let line = 1;
  let statementLine = 1;
  let statementStarted = false;
  let quote = null;

  const flush = () => {
    if (statementStarted) statements.push({ text: buffer.trim(), line: statementLine, blocks: [...enclosingBlocks] });
    buffer = "";
    statementStarted = false;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      buffer += character;
      if (character === "\n") {
        line += 1;
        quote = null;
      } else if (character === "\\") {
        index += 1;
        buffer += text[index] ?? "";
      } else if (character === quote) {
        quote = null;
      }
    } else if (character === "/" && text[index + 1] === "*") {
      const close = text.indexOf("*/", index + 2);
      const end = close === -1 ? text.length : close + 2;
      line += text.slice(index, end).split("\n").length - 1;
      index = end - 1;
    } else if (
      hasLineComments &&
      character === "/" &&
      text[index + 1] === "/" &&
      (index === 0 || /\s/.test(text[index - 1]))
    ) {
      const lineEnd = text.indexOf("\n", index);
      index = (lineEnd === -1 ? text.length : lineEnd) - 1;
    } else if (character === "{") {
      if (enclosingBlocks.length === MAX_CSS_DEPTH) return statements;
      enclosingBlocks.push(buffer.trim());
      buffer = "";
      statementStarted = false;
    } else if (character === ";" || character === "}") {
      flush();
      if (character === "}") enclosingBlocks.pop();
    } else {
      if (character === "\n") line += 1;
      if (!statementStarted && !/\s/.test(character)) {
        statementStarted = true;
        statementLine = line;
      }
      if (character === '"' || character === "'") quote = character;
      buffer += character;
    }
  }
  flush();
  return statements;
}

function splitDeclaration(statement) {
  const colon = statement.indexOf(":");
  if (colon === -1) return null;
  return { property: statement.slice(0, colon).trim(), value: statement.slice(colon + 1).trim() };
}

function isTokenBlock(blocks) {
  const innermost = blocks.at(-1) ?? "";
  const isThemeOrRoot = /^@theme\b/.test(innermost) || TOKEN_BLOCK_SELECTOR.test(innermost);
  return isThemeOrRoot && blocks.slice(0, -1).every((block) => block.startsWith("@layer"));
}

function createFindings() {
  return { tokens: [], brandValues: [], tokensCapped: false, fonts: new Map(), colors: new Map(), radii: new Map() };
}

function countValue(counts, value) {
  counts.set(value, (counts.get(value) ?? 0) + 1);
}

function recordFont(findings, family, source) {
  const existing = findings.fonts.get(family);
  if (existing) existing.count += 1;
  else findings.fonts.set(family, { family, source, count: 1 });
}

function recordToken(findings, name, raw, source, line) {
  if (!SAFE_NAME.test(name.replaceAll(".", "-"))) return;
  const typed = typedTokenValue(name, raw);
  if (!typed) return;
  if (findings.tokens.length === MAX_TOKENS) {
    findings.tokensCapped = true;
    return;
  }
  findings.tokens.push({ name, value: typed.value, source, line });
  if (typed.kind !== "dimension") findings.brandValues.push(typed.value);
  if (typed.kind === "font") recordFont(findings, typed.value, source);
}

function countColorsIn(findings, text) {
  for (const [match] of text.matchAll(HEX_IN_TEXT)) {
    const color = colorValue(match);
    if (color) countValue(findings.colors, color);
  }
  for (const [match] of text.matchAll(COLOR_FUNCTION_IN_TEXT)) {
    const color = colorValue(match);
    if (color) countValue(findings.colors, color);
  }
}

function recordFontImportsIn(findings, text, source) {
  for (const [, names] of text.matchAll(NEXT_FONT_IMPORT)) {
    for (const part of names.split(",")) {
      const font = fontName(part.split(/\sas\s/)[0].replaceAll("_", " "));
      if (font) recordFont(findings, font, source);
    }
  }
  for (const [, slug] of text.matchAll(FONTSOURCE_IMPORT)) {
    const words = slug.split("-").filter(Boolean).map((word) => word[0].toUpperCase() + word.slice(1));
    const font = fontName(words.join(" "));
    if (font) recordFont(findings, font, source);
  }
  for (const [url] of text.matchAll(GOOGLE_FONTS_URL)) {
    for (const [, family] of url.matchAll(GOOGLE_FONT_FAMILY)) {
      const font = fontName(family.replaceAll("+", " "));
      if (font) recordFont(findings, font, source);
    }
  }
}

function scanStylesheet(findings, statements, source) {
  for (const { text, line, blocks } of statements) {
    if (text.startsWith("@")) {
      recordFontImportsIn(findings, text, source);
      continue;
    }
    const declaration = splitDeclaration(text);
    if (!declaration) continue;
    const { property, value } = declaration;
    if (property.startsWith("--") && isTokenBlock(blocks)) {
      recordToken(findings, property, value, source, line);
    }
    if (property === "font-family") {
      const font = firstFontInStack(value);
      if (font) recordFont(findings, font, source);
    }
    if (property === "border-radius" || property.startsWith("--radius")) {
      for (const part of value.split(/\s+/)) {
        const radius = dimensionValue(part);
        if (radius) countValue(findings.radii, radius);
      }
    }
    countColorsIn(findings, value);
  }
}

function scanCode(findings, text, source) {
  countColorsIn(findings, text);
  recordFontImportsIn(findings, text, source);
  for (const [match] of text.matchAll(ROUNDED_CLASS)) countValue(findings.radii, match);
  for (const pattern of [ROUNDED_ARBITRARY_CLASS, JS_BORDER_RADIUS]) {
    for (const [, raw] of text.matchAll(pattern)) {
      const radius = dimensionValue(raw);
      if (radius) countValue(findings.radii, radius);
    }
  }
}

function blankOutComment(comment) {
  return comment.replace(/[^\n]/g, " ");
}

function scanTailwindConfig(findings, rawText, source) {
  const text = rawText.replace(CONFIG_COMMENT, blankOutComment);
  let line = 1;
  let countedUpTo = 0;
  for (const match of text.matchAll(CONFIG_STRING_ENTRY)) {
    for (; countedUpTo < match.index; countedUpTo += 1) {
      if (text[countedUpTo] === "\n") line += 1;
    }
    const [, , name, raw] = match;
    if (colorValue(raw)) recordToken(findings, name, raw, source, line);
  }
  for (const [, block] of text.matchAll(CONFIG_FONT_BLOCK)) {
    for (const [, , , family] of block.matchAll(CONFIG_FONT_ENTRY)) {
      const font = fontName(family);
      if (font) recordFont(findings, font, source);
    }
  }
  scanCode(findings, text, source);
}

function scanContractFrontMatter(findings, text, source) {
  const lines = text.split(/\r?\n/);
  if (lines[0].trim() !== "---") return;
  const path = [];
  for (let index = 1; index < lines.length && lines[index].trim() !== "---"; index += 1) {
    if (lines[index].length > MAX_FRONT_MATTER_LINE_LENGTH) continue;
    const entry = FRONT_MATTER_ENTRY.exec(lines[index]);
    if (!entry || !SAFE_NAME.test(entry[2])) continue;
    const [, indent, key, rawValue] = entry;
    while (path.length > 0 && path.at(-1).indent >= indent.length) path.pop();
    path.push({ indent: indent.length, key });
    if (!CONTRACT_TOKEN_SECTIONS.has(path[0].key)) continue;
    const value = rawValue.replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "");
    if (value) recordToken(findings, path.map((part) => part.key).join("."), value, source, index + 1);
  }
}

function parseJsonObject(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function recordDependencies(dependencies, packageJson) {
  for (const group of [packageJson.dependencies, packageJson.devDependencies]) {
    for (const [name, version] of Object.entries(group ?? {})) {
      if (typeof version === "string" && !dependencies.has(name)) dependencies.set(name, version);
    }
  }
}

function tailwindMajorFromVersion(version) {
  const match = /^[\^~>=<\s]*(\d+)/.exec(version ?? "");
  return match ? Number(match[1]) : null;
}

function nearestTailwindMajor(path, tailwindVersions) {
  let directory = dirname(path);
  for (;;) {
    const major = tailwindMajorFromVersion(tailwindVersions.get(directory));
    if (major !== null) return major;
    if (directory === ".") return null;
    directory = dirname(directory);
  }
}

function detectTailwind(root, files, stylesheets, tailwindVersions) {
  const scannedFiles = new Set(files);
  const configs = files.filter((path) => TAILWIND_CONFIG_FILE.test(path));
  const loadedConfigs = new Set();
  const themeFiles = [];
  let hasV3Directive = false;
  let hasV4Signal = false;
  for (const [source, statements] of stylesheets) {
    for (const { text } of statements) {
      if (/^@tailwind\b/.test(text)) hasV3Directive = true;
      if (/^@import\s+["']tailwindcss/.test(text)) hasV4Signal = true;
      const loaded = /^@config\s+["']([^"']+)["']/.exec(text);
      if (loaded) {
        hasV4Signal = true;
        const target = relative(root, resolve(root, dirname(source), loaded[1])).split(sep).join("/");
        if (scannedFiles.has(target) && CODE_FILE.test(target)) loadedConfigs.add(target);
      }
    }
    if (statements.some(({ blocks }) => /^@theme\b/.test(blocks.at(-1) ?? ""))) {
      hasV4Signal = true;
      themeFiles.push(source);
    }
  }
  const declaredMajor = tailwindMajorFromVersion([...tailwindVersions.values()][0]);
  const inferredMajor = hasV3Directive ? 3 : hasV4Signal ? 4 : null;
  const major = declaredMajor ?? inferredMajor;
  if (major === null && configs.length === 0) return null;
  const isLiveConfig = (path) =>
    loadedConfigs.has(path) || (nearestTailwindMajor(path, tailwindVersions) ?? inferredMajor) === 3;
  const activeConfigs = [
    ...configs.filter(isLiveConfig),
    ...[...loadedConfigs].filter((path) => !configs.includes(path)),
  ];
  return {
    major,
    themeFiles,
    activeConfigs,
    staleConfigs: configs.filter((path) => !activeConfigs.includes(path)),
  };
}

function detectShadcn(componentsJson, files) {
  if (!componentsJson) return null;
  const tailwind = componentsJson.tailwind ?? {};
  return {
    css: files.includes(tailwind.css) ? tailwind.css : null,
    baseColor: BASE_COLOR_NAME.test(tailwind.baseColor) ? tailwind.baseColor : null,
    cssVariables: tailwind.cssVariables === true,
  };
}

function canonicalTokenName(name) {
  return name
    .replace(/^--/, "")
    .replace(/^colors?[.-]/, "")
    .replace(/^rounded\./, "radius-")
    .replaceAll(".", "-");
}

function packageScope(source) {
  return PACKAGE_SCOPE.exec(source)?.[0] ?? "";
}

function disagreesWithinOneScope(tokens) {
  return [...new Set(tokens.map(({ source }) => packageScope(source)))].some((scope) => {
    const visible = tokens.filter(({ source }) => ["", scope].includes(packageScope(source)));
    return (
      new Set(visible.map(({ value }) => value)).size > 1 &&
      new Set(visible.map(({ source }) => source)).size > 1
    );
  });
}

function findConflicts(tokens) {
  const tokensByName = new Map();
  for (const token of tokens) {
    const name = canonicalTokenName(token.name);
    tokensByName.set(name, [...(tokensByName.get(name) ?? []), token]);
  }
  const conflicts = [];
  for (const [name, named] of tokensByName) {
    if (!disagreesWithinOneScope(named)) continue;
    const firstByValue = new Map();
    for (const { value, source, line } of named) {
      if (!firstByValue.has(value)) firstByValue.set(value, { value, source: `${source}:${line}` });
    }
    conflicts.push({ token: name, values: [...firstByValue.values()] });
  }
  return conflicts;
}

function stockComparisonKey(value) {
  const wrappedHsl = /^hsla?\((.*)\)$/.exec(value);
  return wrappedHsl ? wrappedHsl[1].replaceAll(",", " ").replace(/\s+/g, " ").trim() : value;
}

function brandStatus({ tokens, brandValues }) {
  if (tokens.length === 0) return "none";
  return brandValues.every((value) => STOCK_TOKEN_VALUES.has(stockComparisonKey(value))) ? "default" : "real";
}

function topFrequencies(counts) {
  return [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count)
    .slice(0, TOP_FREQUENCIES);
}

function createInventory(root) {
  const { files, truncated, unread: unreadDirectoryEntries } = collectFiles(root);
  let unread = unreadDirectoryEntries;
  let bytesRead = 0;
  let outOfBytes = false;

  const readText = (path) => {
    try {
      const fullPath = join(root, path);
      const { size } = statSync(fullPath);
      outOfBytes ||= bytesRead + size > MAX_TOTAL_BYTES;
      if (size <= MAX_FILE_BYTES && !outOfBytes) {
        bytesRead += size;
        return readFileSync(fullPath, "utf8");
      }
    } catch {}
    unread += 1;
    return null;
  };

  const dependencies = new Map();
  const tailwindVersions = new Map();
  let componentsJson = null;
  const stylesheets = new Map();
  for (const path of files) {
    const fileName = path.split("/").at(-1);
    if (fileName === "package.json") {
      const text = readText(path);
      if (text === null) continue;
      const packageJson = parseJsonObject(text);
      recordDependencies(dependencies, packageJson);
      const version = packageJson.dependencies?.tailwindcss ?? packageJson.devDependencies?.tailwindcss;
      if (typeof version === "string") tailwindVersions.set(dirname(path), version);
    } else if (path === "components.json") {
      const text = readText(path);
      if (text !== null) componentsJson = parseJsonObject(text);
    } else if (STYLE_FILE.test(path) && !MINIFIED_FILE.test(path) && !BUILT_STYLE_FILE.test(path)) {
      const text = readText(path);
      if (text !== null && !TAILWIND_BUILD_HEADER.test(text) && !TAILWIND_COMPILED_THEME.test(text)) {
        stylesheets.set(path, parseCssStatements(text, !path.endsWith(".css")));
      }
    }
  }

  const tailwind = detectTailwind(root, files, stylesheets, tailwindVersions);
  const findings = createFindings();
  for (const path of files) {
    if (tailwind?.activeConfigs.includes(path)) {
      const text = readText(path);
      if (text !== null) scanTailwindConfig(findings, text, path);
    } else if (stylesheets.has(path)) {
      scanStylesheet(findings, stylesheets.get(path), path);
    } else if (DESIGN_CONTRACT_FILE.test(path)) {
      const text = readText(path);
      if (text !== null) scanContractFrontMatter(findings, text, path);
    } else if (CODE_FILE.test(path) && !MINIFIED_FILE.test(path) && !TAILWIND_CONFIG_FILE.test(path)) {
      const text = readText(path);
      if (text !== null) scanCode(findings, text, path);
    }
  }

  const styling = STYLING_PACKAGES.filter((name) => dependencies.has(name));
  if (files.some((path) => /\.module\.(?:css|scss)$/.test(path))) styling.push("css-modules");

  const fonts = [...findings.fonts.values()];
  const logos = files.filter((path) => LOGO_FILE.test(path));
  const contracts = files.filter((path) => CONTRACT_FILE.test(path));
  const listIsCapped = [fonts, logos, contracts].some((list) => list.length > MAX_LISTED_ITEMS);

  return {
    stack: {
      frameworks: FRAMEWORK_PACKAGES.filter((name) => dependencies.has(name)),
      styling,
      tailwind: tailwind && {
        major: tailwind.major,
        themeFiles: tailwind.themeFiles,
        activeConfigs: tailwind.activeConfigs,
        staleConfigs: tailwind.staleConfigs,
      },
      shadcn: detectShadcn(componentsJson, files),
    },
    tokens: findings.tokens,
    fonts: fonts.slice(0, MAX_LISTED_ITEMS),
    logos: logos.slice(0, MAX_LISTED_ITEMS),
    contracts: contracts.slice(0, MAX_LISTED_ITEMS),
    frequencies: { colors: topFrequencies(findings.colors), radii: topFrequencies(findings.radii) },
    brandStatus: brandStatus(findings),
    conflicts: findConflicts(findings.tokens),
    scan: { files: files.length, truncated: truncated || outOfBytes || findings.tokensCapped || listIsCapped, unread },
  };
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

const root = resolve(process.argv[2] ?? ".");
if (!isDirectory(root)) {
  process.stderr.write("inventory: the root is not a directory\n");
  process.exit(EXIT_BAD_ROOT);
}
process.stdout.write(`${JSON.stringify(createInventory(root), null, 2)}\n`);
