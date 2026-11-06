#!/usr/bin/env node

// Read-only source checks. Usage: node check-source.mjs [--tokens <inventory.json>] <paths...>
// Prints JSON to stdout and writes nothing. Exits 1 only for placeholder copy, 2 for bad input.
// Messages hold fixed text and typed values only, because the repo it reads is untrusted.

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

const MAX_FILES = 5000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_FINDINGS_PER_RULE = 100;
const MAX_VALUE_LENGTH = 120;
const MAX_PATH_SPACES = 3;
const MAX_PATH_SEGMENT_LENGTH = 64;
const PLACEHOLDER_HINT_LOOKBACK = 200;
const EXIT_PLACEHOLDER = 1;
const EXIT_BAD_INPUT = 2;

// Source can suggest these but only a rendered page can prove them: one upstream
// detector logged 73 false contrast findings statically against 0 when rendered.
const RENDERED_ONLY_RULES = ["contrast", "target-size", "overflow", "console-errors"];

const SKIPPED_DIRECTORIES = new Set([
  "node_modules", "dist", "build", "out", "coverage", "vendor", "storybook-static",
]);

const SOURCE_FILE = /\.(?:css|scss|sass|less|pcss|tsx?|jsx?|mjs|cjs|html|hbs|ejs|vue|svelte|astro|mdx)$/;
const NON_PRODUCT_FILE =
  /(?:^|\/)(?:tests?|e2e|cypress|fixtures|mocks|__tests__|__mocks__|__fixtures__)\/|\.(?:test|spec|stories|cy)\.[a-z]+$/;
const SAFE_PATH = /^[\p{L}\p{N}_ ./@()+[\]-]{1,200}$/u;
const SAFE_TOKEN_NAME = /^[A-Za-z-][\w-]{0,63}$/;
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/;
const COLOR_FUNCTION =
  /^(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)\((?:[\d.,%\s/+-]|none|deg|rad|turn|srgb|display-p3)+\)$/;

// The lookbehinds keep fragment links out: href="#add" is not a colour.
const COLOR_IN_TEXT =
  /(?<![\w&/])(?<!href=["'])#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)\([^()]{1,80}\)/g;
const TOKEN_DECLARATION_LINE = /^\s*--[\w-]{1,64}\s*:/;
const TOKEN_DECLARATION_MAX_LENGTH = 200;

// The lookbehind keeps globs and quoted strings such as "src/**/*.ts" from opening a comment.
const COMMENT_OPENER = /<!--|(?<![\w*"'`/.-])\/\*|(?<=^|\s)\/\//gm;
const COMMENT_CLOSERS = { "<!--": "-->", "/*": "*/", "//": "\n" };

const PLACEHOLDER_COPY = /\b(?:lorem ipsum|dolor sit amet|john doe|jane doe)\b/gi;
const PLACEHOLDER_HINT = /placeholder["'`]?\s*[=:,]\s*[{(]?\s*(?:[\w.]+\()?\s*["'`][^"'`\n]*$/i;
const SPREAD_PROPS = /\{\s*\.\.\./;
const OVERSHOOTING_CURVE =
  /cubic-bezier\(\s*[\d.]+\s*,\s*(-?[\d.]+)\s*,\s*[\d.]+\s*,\s*(-?[\d.]+)\s*\)/;

function overshoots(match) {
  const curve = OVERSHOOTING_CURVE.exec(match);
  return !curve || [curve[1], curve[2]].some((y) => Number(y) < 0 || Number(y) > 1);
}

const ADVISORY_RULES = [
  {
    rule: "transition-all",
    tier: "reflex",
    pattern: /\btransition(?:-property)?\s*:[^;}\n]{0,80}\ball\b|\btransition-all\b/g,
    message: "transition: all animates every property; name what moves",
  },
  {
    rule: "gradient-text",
    tier: "reflex",
    pattern: /\bbackground-clip\s*:\s*text\b|\bbg-clip-text\b/g,
    message: "gradient-filled text is a common generated look, and rendered contrast cannot be read from it",
  },
  {
    rule: "bounce-easing",
    tier: "reflex",
    pattern: /\banimate-bounce\b|cubic-bezier\([^()]{1,60}\)/g,
    applies: overshoots,
    message: "bounce or overshooting easing; use it only if the brief asks",
  },
  {
    rule: "placeholder-image",
    tier: "reflex",
    pattern:
      /\b(?:i\.pravatar\.cc|randomuser\.me|ui-avatars\.com|api\.dicebear\.com|placekitten\.com|placehold\.co|via\.placeholder\.com|placeimg\.com|dummyimage\.com|fakeimg\.pl|lorempixel\.com|loremflickr\.com|picsum\.photos|source\.unsplash\.com)\b/g,
    message: "image from a placeholder service; use real material or flag the gap",
  },
  {
    rule: "missing-alt",
    tier: "reflex",
    pattern: /<img\b[^>]{0,2000}>/g,
    applies: (tag) => !/\balt\s*=/.test(tag) && !SPREAD_PROPS.test(tag),
    message: "image with no alt attribute",
  },
  {
    rule: "missing-lang",
    tier: "reflex",
    pattern: /<html\b[^>]{0,2000}>/g,
    applies: (tag) => !/\blang\s*=/.test(tag) && !SPREAD_PROPS.test(tag),
    message: "html element with no lang attribute",
  },
  {
    rule: "justified-text",
    tier: "finish",
    pattern: /\btext-align\s*:\s*justify\b|\btext-justify\b(?!\s*:)/g,
    message: "justified text without hyphenation leaves uneven gaps",
  },
];

function fail(problem) {
  process.stderr.write(`check-source: ${problem}\n`);
  process.exit(EXIT_BAD_INPUT);
}

function readArguments() {
  try {
    return parseArgs({ allowPositionals: true, options: { tokens: { type: "string" } } });
  } catch {
    fail("unknown or incomplete flag");
  }
}

function normalizedColor(raw) {
  const value = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (value.length > MAX_VALUE_LENGTH) return null;
  if (HEX_COLOR.test(value)) return value.length > 5 ? value : expandShortHex(value);
  return COLOR_FUNCTION.test(value) ? value : null;
}

function expandShortHex(hex) {
  return `#${[...hex.slice(1)].map((digit) => digit + digit).join("")}`;
}

function readTokensByColor(path) {
  let inventory;
  try {
    const status = lstatSync(path);
    if (!status.isFile() || status.size > MAX_TOTAL_BYTES) fail("the tokens path is not a regular file of a sane size");
    inventory = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail("cannot read the tokens file as JSON");
  }
  if (!Array.isArray(inventory?.tokens)) fail("the tokens file has no tokens list");
  const tokensByColor = new Map();
  for (const { name, value, source, line } of inventory.tokens) {
    const color = typeof value === "string" ? normalizedColor(value) : null;
    if (!color || typeof name !== "string" || !SAFE_TOKEN_NAME.test(name)) continue;
    const token = tokensByColor.get(color) ?? { name, definedAt: new Set() };
    token.definedAt.add(`${source}:${line}`);
    tokensByColor.set(color, token);
  }
  return tokensByColor;
}

function isSafePath(path) {
  return (
    SAFE_PATH.test(path) &&
    path.split(" ").length - 1 <= MAX_PATH_SPACES &&
    path.split("/").every((segment) => segment.length <= MAX_PATH_SEGMENT_LENGTH)
  );
}

function isCheckedFile(path) {
  return SOURCE_FILE.test(path) && !NON_PRODUCT_FILE.test(path);
}

function isWalkedDirectory(name) {
  return !name.startsWith(".") && !SKIPPED_DIRECTORIES.has(name);
}

function listDirectory(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => !entry.isSymbolicLink())
      .filter((entry) => !entry.isDirectory() || isWalkedDirectory(entry.name))
      .map((entry) => join(path, entry.name))
      .sort();
  } catch {
    return null;
  }
}

function readWithinLimits(file, bytesReadSoFar) {
  try {
    const { size } = lstatSync(file);
    if (size > MAX_FILE_BYTES || bytesReadSoFar + size > MAX_TOTAL_BYTES) {
      return { truncated: true };
    }
    return { text: readFileSync(file, "utf8"), size };
  } catch {
    return { truncated: false };
  }
}

function collectFiles(paths) {
  const scan = { files: [], truncated: false, unread: 0, skipped: 0 };
  const queue = paths.map((path) => relative(".", resolve(path)) || ".");
  const namedPaths = new Set(queue);
  while (queue.length > 0) {
    const path = queue.shift();
    if (!isSafePath(path)) {
      scan.unread += 1;
      continue;
    }
    let status;
    try {
      status = lstatSync(path);
    } catch {
      scan.unread += 1;
      continue;
    }
    if (status.isDirectory()) {
      const entries = listDirectory(path);
      if (entries) for (const entry of entries) queue.push(entry);
      else scan.unread += 1;
    } else if (!status.isFile()) {
      scan.unread += 1;
    } else if (isCheckedFile(path)) {
      if (scan.files.length === MAX_FILES) {
        scan.truncated = true;
        return scan;
      }
      scan.files.push(path);
    } else if (namedPaths.has(path)) {
      scan.skipped += 1;
    }
  }
  return scan;
}

function blankOut(text) {
  return text.replace(/[^\n]/g, " ");
}

function blankComments(text) {
  let result = "";
  let cursor = 0;
  for (const opener of text.matchAll(COMMENT_OPENER)) {
    if (opener.index < cursor) continue;
    const closer = COMMENT_CLOSERS[opener[0]];
    const closerIndex = text.indexOf(closer, opener.index + opener[0].length);
    const end = closerIndex === -1 ? text.length : closerIndex + (closer === "\n" ? 0 : closer.length);
    result += text.slice(cursor, opener.index) + blankOut(text.slice(opener.index, end));
    cursor = end;
  }
  return result + text.slice(cursor);
}

function lineStartsOf(text) {
  const starts = [0];
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    starts.push(index + 1);
  }
  return starts;
}

function lineNumberAt(lineStarts, offset) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (lineStarts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

function isInputHint(text, offset) {
  return PLACEHOLDER_HINT.test(text.slice(Math.max(0, offset - PLACEHOLDER_HINT_LOOKBACK), offset));
}

function checkText(rawText, file, tokensByColor, report) {
  const text = blankComments(rawText);
  const lineStarts = lineStartsOf(text);
  const lineOf = (offset) => lineNumberAt(lineStarts, offset);

  // Scans the raw text, because comment stripping cannot tell a regex or a string from a
  // real opener: copy it blanks must stay visible as a finding, never pass in silence.
  for (const match of rawText.matchAll(PLACEHOLDER_COPY)) {
    if (isInputHint(rawText, match.index)) continue;
    const copy = match[0].toLowerCase();
    const looksCommented = text[match.index] !== rawText[match.index];
    report({
      tier: looksCommented ? "reflex" : "floor",
      rule: looksCommented ? "placeholder-in-comment" : "placeholder-copy",
      file,
      line: lineOf(match.index),
      message: looksCommented
        ? `placeholder copy "${copy}" in what looks like a comment; check it is never shown`
        : `placeholder copy "${copy}"; use real material or flag the gap`,
    });
  }
  for (const { rule, tier, pattern, applies, message } of ADVISORY_RULES) {
    for (const match of text.matchAll(pattern)) {
      if (applies && !applies(match[0])) continue;
      report({ tier, rule, file, line: lineOf(match.index), message });
    }
  }
  for (const match of text.matchAll(COLOR_IN_TEXT)) {
    const color = normalizedColor(match[0]);
    const token = color && tokensByColor.get(color);
    if (!token) continue;
    const line = lineOf(match.index);
    const lineStart = lineStarts[line - 1];
    const lineText = text.slice(lineStart, lineStart + TOKEN_DECLARATION_MAX_LENGTH);
    if (token.definedAt.has(`${file}:${line}`) || TOKEN_DECLARATION_LINE.test(lineText)) continue;
    report({
      tier: "reflex",
      rule: "raw-value-beside-token",
      file,
      line,
      message: `raw ${color} matches the token ${token.name}`,
    });
  }
}

function runChecks(paths, tokensByColor) {
  const scan = collectFiles(paths);
  const findings = [];
  const countByRule = new Map();
  const report = (finding) => {
    const count = countByRule.get(finding.rule) ?? 0;
    countByRule.set(finding.rule, count + 1);
    if (count < MAX_FINDINGS_PER_RULE) findings.push(finding);
    else scan.truncated = true;
  };

  let bytesRead = 0;
  let filesRead = 0;
  for (const file of scan.files) {
    const { text, size, truncated } = readWithinLimits(file, bytesRead);
    if (text === undefined) {
      scan.unread += 1;
      scan.truncated ||= truncated;
      continue;
    }
    bytesRead += size;
    filesRead += 1;
    checkText(text, file, tokensByColor, report);
  }
  return {
    findings,
    blocked: countByRule.has("placeholder-copy"),
    scan: { files: filesRead, truncated: scan.truncated, unread: scan.unread, skipped: scan.skipped },
  };
}

// Node exits 1 on an uncaught error, which callers would read as placeholder copy.
try {
  const { values: options, positionals: paths } = readArguments();
  const tokensByColor = options.tokens ? readTokensByColor(options.tokens) : new Map();
  const { findings, blocked, scan } = runChecks(paths, tokensByColor);
  if (scan.files === 0) fail("read no source file; report these checks as not run");

  process.stdout.write(`${JSON.stringify({ findings, notVerified: RENDERED_ONLY_RULES, scan }, null, 2)}\n`);
  if (blocked) process.exitCode = EXIT_PLACEHOLDER;
} catch {
  fail("could not finish; report these checks as not run");
}
