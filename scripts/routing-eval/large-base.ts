import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { integerBetween, mulberry32, pickFrom, type Random } from "./random.js";

interface PlantedFile {
  path: string;
  header: readonly string[];
  functions: readonly string[];
}

const DOMAINS = [
  "accounts",
  "admin",
  "billing",
  "carriers",
  "catalog",
  "claims",
  "config",
  "customs",
  "dispatch",
  "fleet",
  "jobs",
  "ledger",
  "notifications",
  "orders",
  "payments",
  "pricing",
  "reconcile",
  "reporting",
  "returns",
  "settlement",
];
const FILLER_FILES_PER_DOMAIN = 21;
const VERBS = [
  "apply",
  "build",
  "compute",
  "resolve",
  "merge",
  "check",
  "load",
  "format",
  "normalize",
  "collect",
  "score",
  "split",
  "track",
  "estimate",
  "validate",
  "select",
  "rank",
  "summarize",
  "queue",
  "schedule",
  "close",
  "settle",
  "adjust",
  "reconcile",
];
const NOUNS = [
  "Parcel",
  "Route",
  "Invoice",
  "Ledger",
  "Balance",
  "Carrier",
  "Timeout",
  "Region",
  "Account",
  "Claim",
  "Payout",
  "Credit",
  "Manifest",
  "Zone",
  "Rate",
  "Shipment",
  "Window",
  "Batch",
  "Book",
  "Adjustment",
  "Settlement",
  "Request",
  "Retry",
  "Config",
];
const QUALIFIERS = [
  "",
  "Totals",
  "Limits",
  "Entries",
  "Rules",
  "Snapshot",
  "Draft",
  "Summary",
  "Delta",
  "Weights",
  "Policy",
  "Forward",
  "Window",
  "Cache",
  "Report",
  "State",
];
const FILE_SUFFIXES = [
  "rules",
  "store",
  "format",
  "limits",
  "queue",
  "totals",
  "policy",
  "sync",
  "helpers",
  "state",
  "cache",
  "export",
];
const RECORD_FIELDS = [
  "weightKg",
  "totalCents",
  "count",
  "distanceKm",
  "days",
  "score",
  "quantity",
  "limit",
];
const MIN_FILE_LINES = 60;
const MAX_TARGET_FILE_LINES = 100;

const ANSWER_REQUEST_ID = "req-7c41e09a";
const LOG_LINE_COUNT = 5000;
const REQUEST_LINE_BUDGET = 4500;
const LOG_START_MS = Date.UTC(2026, 10, 3, 8, 0, 0);
const REQUEST_PATHS = [
  "/v1/quotes",
  "/v1/orders",
  "/v1/labels",
  "/v1/tracking",
  "/v1/returns",
  "/v1/invoices",
];
const RECOVERED_STATUS_SEQUENCES: readonly (readonly number[])[] = [
  [200],
  [200],
  [201],
  [204],
  [202, 200],
  [500, 200],
  [500, 500, 201],
  [404],
  [422],
  [503, 200],
  [500, 204],
];
const FAILED_FOR_GOOD_SEQUENCE = [202, 500];
const LONGEST_SEQUENCE = 3;
const SERVER_ERROR_STATUS = 500;
const CLIENT_ERROR_STATUS = 400;

const PLANTED_FILES: readonly PlantedFile[] = [
  {
    path: "src/ledger/adjustments.js",
    header: [],
    functions: [
      `export function postAdjustment(ledger, accountId, amountCents, reason) {
  const entry = { accountId, amountCents, reason, postedAt: ledger.clock() };
  ledger.entries.push(entry);
  return entry;
}`,
    ],
  },
  {
    path: "src/jobs/nightly.js",
    header: ['import { settleRegion } from "../settlement/regions.js";'],
    functions: [
      `export function runNightlySettlement(regions, ledger) {
  return regions
    .filter((region) => region.active)
    .map((region) => settleRegion(region, ledger));
}`,
    ],
  },
  {
    path: "src/jobs/weekly.js",
    header: ['import { closeWeeklyBooks } from "../settlement/weekly.js";'],
    functions: [
      `export function runWeeklySettlement(regions, ledger) {
  return regions.map((region) => closeWeeklyBooks(region, ledger));
}`,
    ],
  },
  {
    path: "src/settlement/regions.js",
    header: [
      'import { reconcileBalances } from "../reconcile/balances.js";',
      'import { closeRegionBooks } from "./books.js";',
    ],
    functions: [
      `export function settleRegion(region, ledger) {
  const books = closeRegionBooks(region, ledger);
  return { region: region.code, closed: books.length };
}`,
      `export function previewRegionSettlement(region, ledger) {
  return reconcileBalances(region.accounts, ledger, { dryRun: true });
}`,
    ],
  },
  {
    path: "src/settlement/books.js",
    header: [
      'import { postAdjustment } from "../ledger/adjustments.js";',
      'import { applyCarryForward } from "../reconcile/carry.js";',
    ],
    functions: [
      `export function closeRegionBooks(region, ledger) {
  return region.accounts.map((account) => applyCarryForward(account, ledger));
}`,
      `export function closeRegionBooksLegacy(region, ledger) {
  return region.accounts.map((account) =>
    postAdjustment(ledger, account.id, -account.openCents, "legacy close"),
  );
}`,
    ],
  },
  {
    path: "src/reconcile/carry.js",
    header: ['import { postAdjustment } from "../ledger/adjustments.js";'],
    functions: [
      `export function applyCarryForward(account, ledger) {
  if (account.openCents === 0) return null;
  return postAdjustment(ledger, account.id, account.openCents, "carry forward");
}`,
    ],
  },
  {
    path: "src/reconcile/balances.js",
    header: ['import { postAdjustment } from "../ledger/adjustments.js";'],
    functions: [
      `export function reconcileBalances(accounts, ledger, options = {}) {
  const drifted = accounts.filter(
    (account) => account.bookedCents !== account.actualCents,
  );
  if (options.dryRun) return drifted;
  return drifted.map((account) =>
    postAdjustment(
      ledger,
      account.id,
      account.actualCents - account.bookedCents,
      "reconcile",
    ),
  );
}`,
    ],
  },
  {
    path: "src/settlement/weekly.js",
    header: ['import { postAdjustment } from "../ledger/adjustments.js";'],
    functions: [
      `export function closeWeeklyBooks(region, ledger) {
  return region.accounts.map((account) =>
    postAdjustment(ledger, account.id, account.weeklyCents, "weekly close"),
  );
}`,
    ],
  },
  {
    path: "src/settlement/manual.js",
    header: ['import { postAdjustment } from "../ledger/adjustments.js";'],
    functions: [
      `export function settleRegionManually(region, ledger, amounts) {
  return amounts.map(({ accountId, cents }) =>
    postAdjustment(ledger, accountId, cents, \`manual \${region.code}\`),
  );
}`,
    ],
  },
  {
    path: "src/admin/tools.js",
    header: ['import { settleRegionManually } from "../settlement/manual.js";'],
    functions: [
      `export function runManualSettlement(request, ledger) {
  return settleRegionManually(request.region, ledger, request.amounts);
}`,
    ],
  },
  {
    path: "src/claims/payouts.js",
    header: ['import { postAdjustment } from "../ledger/adjustments.js";'],
    functions: [
      `export function settleClaimPayout(claim, ledger) {
  return postAdjustment(ledger, claim.accountId, claim.approvedCents, "claim");
}`,
    ],
  },
  {
    path: "src/returns/credits.js",
    header: ['import { postAdjustment } from "../ledger/adjustments.js";'],
    functions: [
      `export function creditReturnedParcel(parcel, ledger) {
  return postAdjustment(ledger, parcel.accountId, parcel.refundCents, "return");
}`,
    ],
  },
  {
    path: "src/billing/corrections.js",
    header: ['import { postAdjustment } from "../ledger/adjustments.js";'],
    functions: [
      `export function correctInvoiceTotals(invoice, ledger) {
  const gap = invoice.expectedCents - invoice.billedCents;
  return gap === 0 ? null : postAdjustment(ledger, invoice.accountId, gap, "correction");
}`,
    ],
  },
  {
    path: "src/main.js",
    header: [
      'import { startCarriers } from "./carriers/start.js";',
      'import { loadConfig } from "./config/load.js";',
    ],
    functions: [
      `export function startApp(env) {
  const config = loadConfig(env);
  return { config, carriers: startCarriers(config) };
}`,
    ],
  },
  {
    path: "src/config/load.js",
    header: [],
    functions: [
      `export function loadConfig(env) {
  return {
    network: { requestTimeoutMs: Number(env.REQUEST_TIMEOUT_MS ?? 4000) },
    carriers: {
      baseUrl: env.CARRIER_URL ?? "https://carriers.example",
      timeoutMs: Number(env.CARRIER_TIMEOUT_MS ?? 15000),
    },
  };
}`,
    ],
  },
  {
    path: "src/config/carrier.js",
    header: ["const FALLBACK_CARRIER_TIMEOUT_MS = 15000;"],
    functions: [
      `export function resolveCarrierTimeout(config) {
  return config.carriers.timeoutMs ?? FALLBACK_CARRIER_TIMEOUT_MS;
}`,
    ],
  },
  {
    path: "src/admin/diagnostics.js",
    header: ['import { resolveCarrierTimeout } from "../config/carrier.js";'],
    functions: [
      `export function describeCarrierSetup(config) {
  return \`carriers at \${config.carriers.baseUrl}, timeout \${resolveCarrierTimeout(config)}ms\`;
}`,
    ],
  },
  {
    path: "src/carriers/start.js",
    header: [
      'import { createCarrierClient } from "./client.js";',
      'import { carrierTimeoutFor } from "./policy/timeouts.js";',
    ],
    functions: [
      `export function startCarriers(config) {
  return createCarrierClient({
    baseUrl: config.carriers.baseUrl,
    timeoutMs: carrierTimeoutFor(config),
  });
}`,
    ],
  },
  {
    path: "src/carriers/sandbox.js",
    header: [
      'import { createCarrierClient } from "./client.js";',
      'import { sandboxCarrierTimeout } from "./policy/timeouts.js";',
    ],
    functions: [
      `export function startSandboxCarriers(config) {
  return createCarrierClient({
    baseUrl: "https://sandbox.carriers.example",
    timeoutMs: sandboxCarrierTimeout(config),
  });
}`,
    ],
  },
  {
    path: "src/carriers/policy/timeouts.js",
    header: ["const MAX_CARRIER_TIMEOUT_MS = 20000;"],
    functions: [
      `export function sandboxCarrierTimeout(config) {
  return config.carriers.timeoutMs;
}`,
      `export function carrierTimeoutFor(config) {
  return Math.min(config.network.requestTimeoutMs * 2, MAX_CARRIER_TIMEOUT_MS);
}`,
      `export function defaultCarrierTimeout() {
  return MAX_CARRIER_TIMEOUT_MS;
}`,
    ],
  },
  {
    path: "src/carriers/client.js",
    header: [],
    functions: [
      `export function createCarrierClient(options) {
  return { baseUrl: options.baseUrl, timeoutMs: options.timeoutMs, sent: [] };
}`,
    ],
  },
];

const PACKAGE_JSON = `${JSON.stringify(
  { name: "freightdesk", version: "1.0.0", private: true, type: "module" },
  null,
  2,
)}\n`;

function plantedFunctionNames(): Set<string> {
  return new Set(
    PLANTED_FILES.flatMap(({ functions }) =>
      functions.flatMap((block) =>
        [...block.matchAll(/export function (\w+)\(/gu)].map(
          (match) => match[1],
        ),
      ),
    ),
  );
}

function uniqueFunctionNamer(
  random: Random,
  reserved: Set<string>,
): () => string {
  const used = new Set(reserved);
  return () => {
    for (;;) {
      const name = `${pickFrom(random, VERBS)}${pickFrom(random, NOUNS)}${pickFrom(random, QUALIFIERS)}`;
      if (!used.has(name)) {
        used.add(name);
        return name;
      }
    }
  };
}

function fillerFunction(
  random: Random,
  name: string,
  importedCallee?: string,
): string {
  const field = pickFrom(random, RECORD_FIELDS);
  const offset = integerBetween(random, 1, 90);
  const adjusted = importedCallee
    ? `${importedCallee}({ ${pickFrom(random, RECORD_FIELDS)}: value + ${offset} })`
    : `value + ${offset}`;
  return `export function ${name}(record, options = {}) {
  const value = record.${field} ?? ${integerBetween(random, 0, 50)};
  const factor = options.factor ?? ${integerBetween(random, 5, 150)} / 100;
  if (value > ${integerBetween(random, 10, 900)}) {
    return Math.round(value * factor);
  }
  const adjusted = ${adjusted};
  return adjusted - (adjusted % ${integerBetween(random, 2, 9)});
}`;
}

function renderModule(
  header: readonly string[],
  functions: readonly string[],
): string {
  const sections = header.length > 0 ? [header.join("\n")] : [];
  return `${[...sections, ...functions].join("\n\n")}\n`;
}

function lineCount(contents: string): number {
  return contents.trimEnd().split("\n").length;
}

function padModule(
  random: Random,
  nextName: () => string,
  header: readonly string[],
  functions: readonly string[],
): { contents: string; exported: string[] } {
  const targetLines = integerBetween(
    random,
    MIN_FILE_LINES,
    MAX_TARGET_FILE_LINES,
  );
  const padded = [...functions];
  const exported: string[] = [];
  while (lineCount(renderModule(header, padded)) < targetLines) {
    const name = nextName();
    exported.push(name);
    padded.push(fillerFunction(random, name));
  }
  return { contents: renderModule(header, padded), exported };
}

function fillerModuleNames(random: Random): string[] {
  const names = new Set<string>();
  while (names.size < FILLER_FILES_PER_DOMAIN) {
    names.add(
      `${pickFrom(random, NOUNS).toLowerCase()}-${pickFrom(random, FILE_SUFFIXES)}`,
    );
  }
  return [...names];
}

function fillerModules(
  random: Random,
  nextName: () => string,
): Map<string, string> {
  const modules = new Map<string, string>();
  for (const domain of DOMAINS) {
    const written: { module: string; exported: string[] }[] = [];
    for (const module of fillerModuleNames(random)) {
      const dependency = written.length > 0 ? pickFrom(random, written) : null;
      const callee = dependency ? pickFrom(random, dependency.exported) : null;
      const header = callee
        ? [`import { ${callee} } from "./${dependency?.module}.js";`]
        : [];
      const firstName = nextName();
      const { contents, exported } = padModule(random, nextName, header, [
        fillerFunction(random, firstName, callee ?? undefined),
      ]);
      written.push({ module, exported: [firstName, ...exported] });
      modules.set(`src/${domain}/${module}.js`, contents);
    }
  }
  return modules;
}

function plantedModules(
  random: Random,
  nextName: () => string,
): Map<string, string> {
  return new Map(
    PLANTED_FILES.map(({ path, header, functions }) => [
      path,
      padModule(random, nextName, header, functions).contents,
    ]),
  );
}

interface LogLine {
  atMs: number;
  text: string;
}

function requestId(random: Random): string {
  return `req-${Math.floor(random() * 2 ** 32)
    .toString(16)
    .padStart(8, "0")}`;
}

function levelFor(status: number): string {
  if (status >= SERVER_ERROR_STATUS) return "ERROR";
  if (status >= CLIENT_ERROR_STATUS) return "WARN";
  return "INFO";
}

function requestLines(
  random: Random,
  id: string,
  startMs: number,
  statuses: readonly number[],
): LogLine[] {
  const method = pickFrom(random, ["GET", "POST", "PUT"]);
  const path = pickFrom(random, REQUEST_PATHS);
  let atMs = startMs;
  return statuses.map((status) => {
    atMs += integerBetween(random, 20, 3000);
    return {
      atMs,
      text: `${levelFor(status)} request=${id} method=${method} path=${path} status=${status} latency_ms=${integerBetween(random, 3, 900)}`,
    };
  });
}

function noiseLine(random: Random, atMs: number): LogLine {
  const text =
    random() < 0.5
      ? `DEBUG cache hits=${integerBetween(random, 0, 900)} misses=${integerBetween(random, 0, 600)} evicted=${integerBetween(random, 0, 500)}`
      : `INFO worker=${integerBetween(random, 1, 8)} heartbeat queue_depth=${integerBetween(random, 0, 700)}`;
  return { atMs, text };
}

function applicationLog(random: Random): string {
  const usedIds = new Set([ANSWER_REQUEST_ID]);
  const lines: LogLine[] = [];
  let startMs = LOG_START_MS;
  let answerPlanted = false;
  while (lines.length + LONGEST_SEQUENCE <= REQUEST_LINE_BUDGET) {
    startMs += integerBetween(random, 50, 400);
    if (!answerPlanted && lines.length >= REQUEST_LINE_BUDGET / 2) {
      lines.push(
        ...requestLines(
          random,
          ANSWER_REQUEST_ID,
          startMs,
          FAILED_FOR_GOOD_SEQUENCE,
        ),
      );
      answerPlanted = true;
      continue;
    }
    let id = requestId(random);
    while (usedIds.has(id)) id = requestId(random);
    usedIds.add(id);
    lines.push(
      ...requestLines(
        random,
        id,
        startMs,
        pickFrom(random, RECOVERED_STATUS_SEQUENCES),
      ),
    );
  }
  const lastMs = Math.max(...lines.map((line) => line.atMs));
  while (lines.length < LOG_LINE_COUNT) {
    lines.push(noiseLine(random, integerBetween(random, LOG_START_MS, lastMs)));
  }
  return lines
    .sort((first, second) => first.atMs - second.atMs)
    .map((line) => `${new Date(line.atMs).toISOString()} ${line.text}\n`)
    .join("");
}

export async function generateLargeBase(
  targetDirectory: string,
  seed: number,
): Promise<void> {
  const random = mulberry32(seed);
  const nextName = uniqueFunctionNamer(random, plantedFunctionNames());
  const files = new Map([
    ["package.json", PACKAGE_JSON],
    ...fillerModules(random, nextName),
    ...plantedModules(random, nextName),
    ["logs/app.log", applicationLog(random)],
  ]);
  for (const [path, contents] of files) {
    const target = join(targetDirectory, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
}
