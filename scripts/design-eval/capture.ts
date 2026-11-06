import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { renderViews } from "./chrome.js";
import { type Arm, EVAL_ROOT, parseArm } from "./claude.js";
import { layoutHash, paletteEntropy } from "./measures.js";
import type { OutputCase } from "./output.js";

const REPOSITORY_ROOT = resolve(EVAL_ROOT, "..", "..");
const AUDIT_SCRIPT = join(
  REPOSITORY_ROOT,
  "assets/skills/design/agemon-design/scripts/audit-page.js",
);
const CHECK_SOURCE_SCRIPT = join(
  REPOSITORY_ROOT,
  "assets/skills/design/agemon-design/scripts/check-source.mjs",
);
const FINGERPRINT_SCRIPT = join(import.meta.dirname, "page-fingerprint.js");
const ACCEPTANCE_FILE = join(EVAL_ROOT, "acceptance.json");
const RESULTS_DIRECTORY = join(EVAL_ROOT, "results");

export const DESKTOP_WIDTH = 1440;
const VIEW_WIDTHS = [DESKTOP_WIDTH, 768, 375];
const RENDERED_FLOORS = 3;
const EXIT_PLACEHOLDER_COPY = 1;
const EXIT_BAD_INPUT = 2;
const SOURCE_FILE = /\.(?:html|css|tsx?|jsx?|mdx?)$/u;
const SKIPPED_SOURCE_DIRECTORIES = new Set([
  ".claude",
  ".design",
  ".next",
  "node_modules",
]);

export interface RankedValue {
  value: string;
  count: number;
}

export interface ViewCapture {
  audit: {
    overflow: unknown[];
    targets: unknown[];
    contrast: unknown[];
    notVerified: unknown[];
    fonts: { family: string; count: number }[];
    palette: RankedValue[];
    radii: RankedValue[];
    scan: { elements: number; contrastChecked: number; truncated: boolean };
  };
  fingerprint: {
    shadows: RankedValue[];
    layout: string[];
    paletteFamily: string;
    tells: Record<string, boolean>;
  };
  consoleErrors: number;
}

export interface AcceptanceResult {
  id: string;
  met: boolean;
}

export interface BuildCapture {
  brief: string;
  arm: Arm;
  repeat: number;
  page: string;
  status: "rendered" | "not-rendered";
  reason?: string;
  views: Record<number, ViewCapture>;
  acceptance: AcceptanceResult[];
  placeholderCopy: boolean | null;
}

export interface AcceptanceCriterion {
  id: string;
  selector?: string;
  minCount?: number;
  pattern?: string;
  minMatches?: number;
  sourcePattern?: string;
}

function desktopView(capture: BuildCapture): ViewCapture | undefined {
  return capture.views[DESKTOP_WIDTH] ?? Object.values(capture.views)[0];
}

export function buildFingerprint(capture: BuildCapture) {
  const view = desktopView(capture);
  if (!view) return null;
  const { audit, fingerprint } = view;
  return {
    fonts: audit.fonts.map(({ family }) => family),
    paletteEntropy: paletteEntropy(audit.palette),
    paletteFamily: fingerprint.paletteFamily,
    radii: audit.radii.map(({ value }) => value),
    shadows: fingerprint.shadows.map(({ value }) => value),
    layoutHash: layoutHash(fingerprint.layout),
    tellCount: Object.values(fingerprint.tells).filter(Boolean).length,
  };
}

// One point per brief criterion, plus the floors the skill itself treats as blocking.
export function buildAppropriateness(capture: BuildCapture) {
  const of = capture.acceptance.length + RENDERED_FLOORS;
  if (capture.status !== "rendered") return { points: 0, of };
  const views = Object.values(capture.views);
  const floorsHeld = [
    views.every(({ audit }) => audit.contrast.length === 0),
    views.every(({ audit }) => audit.overflow.length === 0),
    capture.placeholderCopy === false,
  ].filter(Boolean).length;
  const criteriaMet = capture.acceptance.filter(({ met }) => met).length;
  return { points: criteriaMet + floorsHeld, of };
}

export function scoreAcceptanceSource(
  criteria: AcceptanceCriterion[],
  sourceText: string,
): AcceptanceResult[] {
  return criteria.map(({ id, sourcePattern }) => ({
    id,
    met: new RegExp(sourcePattern as string, "iu").test(sourceText),
  }));
}

function renderedAcceptanceExpression(criteria: AcceptanceCriterion[]): string {
  return `((criteria) => {
    const text = document.body.innerText;
    return criteria.map(({ id, selector, minCount = 1, pattern, minMatches = 1 }) => ({
      id,
      met:
        (!selector || document.querySelectorAll(selector).length >= minCount) &&
        (!pattern || (text.match(new RegExp(pattern, "giu")) ?? []).length >= minMatches),
    }));
  })(${JSON.stringify(criteria)})`;
}

function productSourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    const stats = lstatSync(path);
    if (stats.isDirectory()) {
      return SKIPPED_SOURCE_DIRECTORIES.has(name)
        ? []
        : productSourceFiles(path);
    }
    return stats.isFile() && SOURCE_FILE.test(name) ? [path] : [];
  });
}

function hasPlaceholderCopy(
  projectDirectory: string,
  files: string[],
): boolean | null {
  if (files.length === 0) return null;
  const projectFiles = files.map((file) => relative(projectDirectory, file));
  try {
    execFileSync("node", [CHECK_SOURCE_SCRIPT, ...projectFiles], {
      cwd: projectDirectory,
      stdio: "ignore",
    });
    return false;
  } catch (error) {
    const { status } = error as { status?: number };
    if (status === EXIT_PLACEHOLDER_COPY) return true;
    if (status === EXIT_BAD_INPUT) return null;
    throw error;
  }
}

export function acceptanceCriteria(brief: string): AcceptanceCriterion[] {
  const all = JSON.parse(readFileSync(ACCEPTANCE_FILE, "utf8")) as Record<
    string,
    AcceptanceCriterion[]
  >;
  return all[brief] ?? [];
}

export function capturesDirectory(label: string): string {
  return join(RESULTS_DIRECTORY, "captures", label);
}

export function captureDirectory(
  label: string,
  brief: string,
  arm: Arm,
  repeat: number,
): string {
  return join(capturesDirectory(label), brief, `${arm}-${repeat}`);
}

export function screenshotFile(width: number): string {
  return `shot-${width}.png`;
}

export interface CaptureRequest {
  label: string;
  brief: string;
  arm: Arm;
  repeat: number;
  projectDirectory: string;
  page: string;
}

export async function captureBuild(
  request: CaptureRequest,
): Promise<BuildCapture> {
  const { brief, arm, repeat, projectDirectory, page } = request;
  const url = /^[a-z]+:\/\//u.test(page)
    ? page
    : pathToFileURL(resolve(projectDirectory, page)).href;
  const criteria = acceptanceCriteria(brief);
  const rendered = criteria.filter((criterion) => !criterion.sourcePattern);
  const fromSource = criteria.filter((criterion) => criterion.sourcePattern);
  const files = productSourceFiles(projectDirectory);
  const sourceText = files.map((file) => readFileSync(file, "utf8")).join("\n");
  const directory = captureDirectory(request.label, brief, arm, repeat);
  mkdirSync(directory, { recursive: true });

  const expressions = [
    readFileSync(AUDIT_SCRIPT, "utf8"),
    readFileSync(FINGERPRINT_SCRIPT, "utf8"),
    renderedAcceptanceExpression(rendered),
  ];
  const views: Record<number, ViewCapture> = {};
  let renderedAcceptance: AcceptanceResult[] = [];
  const shots = await renderViews(url, VIEW_WIDTHS, expressions);
  for (const [width, view] of shots) {
    const [audit, fingerprint, acceptance] = view.evaluated;
    views[width] = {
      audit: audit as ViewCapture["audit"],
      fingerprint: fingerprint as ViewCapture["fingerprint"],
      consoleErrors: view.consoleErrors,
    };
    if (width === DESKTOP_WIDTH) {
      renderedAcceptance = acceptance as AcceptanceResult[];
    }
    writeFileSync(join(directory, screenshotFile(width)), view.screenshot);
  }
  return saveCapture(directory, {
    brief,
    arm,
    repeat,
    page,
    status: "rendered",
    views,
    acceptance: [
      ...renderedAcceptance,
      ...scoreAcceptanceSource(fromSource, sourceText),
    ],
    placeholderCopy: hasPlaceholderCopy(projectDirectory, files),
  });
}

function saveCapture(directory: string, capture: BuildCapture): BuildCapture {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "capture.json"),
    `${JSON.stringify(capture, null, 2)}\n`,
  );
  return capture;
}

function recordNotRendered(
  request: Omit<CaptureRequest, "projectDirectory">,
  reason: string,
): BuildCapture {
  const { label, brief, arm, repeat, page } = request;
  return saveCapture(captureDirectory(label, brief, arm, repeat), {
    brief,
    arm,
    repeat,
    page,
    status: "not-rendered",
    reason,
    views: {},
    acceptance: acceptanceCriteria(brief).map(({ id }) => ({ id, met: false })),
    placeholderCopy: null,
  });
}

interface BuildRecord {
  brief: string;
  arm: Arm;
  repeat: number;
  projectDirectory: string;
  productFiles: string[];
  errored?: string;
}

function resultsFilesFor(label: string): string[] {
  const armAndLater = new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${label}-arm-`, "u");
  return readdirSync(RESULTS_DIRECTORY)
    .filter((name) => armAndLater.test(name) && name.endsWith(".json"))
    .map((name) => join(RESULTS_DIRECTORY, name));
}

function buildRecords(label: string): BuildRecord[] {
  return resultsFilesFor(label).flatMap((file) => {
    const results = JSON.parse(readFileSync(file, "utf8")) as {
      arm: Arm;
      cases: OutputCase[];
    };
    return results.cases.map((outputCase) => ({
      brief: outputCase.brief,
      arm: results.arm,
      repeat: outputCase.repeat ?? 1,
      projectDirectory: join(EVAL_ROOT, outputCase.keptProject ?? "missing"),
      productFiles: outputCase.productFiles ?? [],
      errored: outputCase.status === "ok" ? undefined : outputCase.status,
    }));
  });
}

export function pageOfBuild(productFiles: string[]): string | undefined {
  return productFiles.filter((file) => file.endsWith(".html")).at(-1);
}

async function captureBatch(label: string): Promise<void> {
  for (const record of buildRecords(label)) {
    const { brief, arm, repeat, projectDirectory, productFiles } = record;
    const name = `${brief} ${arm}-${repeat}`;
    const page = pageOfBuild(productFiles);
    const target = { label, brief, arm, repeat, page: page ?? "" };
    if (record.errored || !existsSync(projectDirectory)) {
      recordNotRendered(target, record.errored ?? "project-missing");
      console.log(`${name}: not rendered, build failed or missing`);
    } else if (!page) {
      // Framework builds need a server the batch does not start: see --url.
      console.log(`${name}: no HTML page; capture it with --url`);
    } else {
      await captureOrRecord({ ...target, projectDirectory, page });
      console.log(`${name}: ${page}`);
    }
  }
}

async function captureOrRecord(request: CaptureRequest): Promise<void> {
  try {
    await captureBuild(request);
  } catch (error) {
    recordNotRendered(request, (error as Error).message);
    console.log(`  failed: ${(error as Error).message}`);
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      label: { type: "string" },
      brief: { type: "string" },
      arm: { type: "string" },
      repeat: { type: "string" },
      project: { type: "string" },
      url: { type: "string" },
    },
  });
  if (!values.label) throw new Error("--label is required");
  if (!values.url) {
    await captureBatch(values.label);
    return;
  }
  if (!values.brief || !values.project) {
    throw new Error("--url also needs --brief, --arm, --repeat and --project");
  }
  const arm = parseArm(values.arm);
  const repeat = Number(values.repeat);
  await captureOrRecord({
    label: values.label,
    brief: values.brief,
    arm,
    repeat,
    projectDirectory: resolve(values.project),
    page: values.url,
  });
  console.log(
    `saved: ${captureDirectory(values.label, values.brief, arm, repeat)}`,
  );
}

if (import.meta.filename === process.argv[1]) {
  await main();
}
