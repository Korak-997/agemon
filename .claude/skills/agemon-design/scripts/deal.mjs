#!/usr/bin/env node

// Picks one design direction outside the model, because a model's own pick falls
// back on the typical option.
// Usage: node deal.mjs --specs <path> --log <path> --seed <string> [--tau 1.75] [--pick <id>] [--check]
// Prints the result as JSON and appends one line to the log.
// --check writes nothing and hides the pick, so a preview cannot be re-rolled by editing specs.
// Only ids and axis buckets reach the log, because later sessions read it back.

import { createHash } from "node:crypto";
import { appendFileSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

const AXES = ["palette", "type", "layout", "density", "signature"];
const SPEC_COUNT = 3;
const DEFAULT_TAU = "1.75";
const RECENT_LOG_ENTRIES = 5;
const COLLISION_PENALTY = 0.25;
// Keeps a spec of zero typicality selectable; a zero weight could never be dealt.
const MIN_TYPICALITY = 0.01;
const EXIT_BAD_INPUT = 2;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG_LENGTH = 64;

function fail(problem) {
  process.stderr.write(`deal: ${problem}\n`);
  process.exit(EXIT_BAD_INPUT);
}

function readArguments() {
  try {
    return parseArgs({
      options: {
        specs: { type: "string" },
        log: { type: "string" },
        seed: { type: "string" },
        tau: { type: "string", default: DEFAULT_TAU },
        pick: { type: "string" },
        check: { type: "boolean", default: false },
      },
    }).values;
  } catch {
    fail("unknown or incomplete flag");
  }
}

function isSlug(value) {
  return typeof value === "string" && value.length <= MAX_SLUG_LENGTH && SLUG.test(value);
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function specProblem(spec) {
  if (!isObject(spec)) return "a spec is not an object";
  if (!isSlug(spec.id)) return "a spec id is not a lowercase slug";
  if (typeof spec.summary !== "string" || typeof spec.subjectBasis !== "string") {
    return `spec ${spec.id} needs a summary and a subjectBasis`;
  }
  if (typeof spec.typicality !== "number" || !(spec.typicality >= 0 && spec.typicality <= 1)) {
    return `spec ${spec.id} needs a typicality from 0 to 1`;
  }
  if (!isObject(spec.axes) || !AXES.every((axis) => isSlug(spec.axes[axis]))) {
    return `spec ${spec.id} needs ${AXES.join(", ")} as lowercase slugs`;
  }
}

function directionsProblem(directions) {
  if (!isObject(directions)) return "the specs file is not an object";
  if (!isSlug(directions.briefSlug)) return "briefSlug is not a lowercase slug";
  if (directions.locks !== undefined && !isObject(directions.locks)) return "locks is not an object";
  if (!Array.isArray(directions.specs) || directions.specs.length !== SPEC_COUNT) {
    return `the specs file needs exactly ${SPEC_COUNT} specs`;
  }
  const problem = directions.specs.map(specProblem).find(Boolean);
  if (problem) return problem;
  if (new Set(directions.specs.map((spec) => spec.id)).size !== SPEC_COUNT) {
    return "spec ids repeat";
  }
}

function readDirections(path) {
  let directions;
  try {
    directions = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail("cannot read the specs file as JSON");
  }
  const problem = directionsProblem(directions);
  if (problem) fail(problem);
  return directions;
}

function refuseSymlinkedLog(path) {
  try {
    if (lstatSync(path).isSymbolicLink()) fail("the log is a symlink");
  } catch (error) {
    if (error.code !== "ENOENT") fail("cannot read the log");
  }
}

function readLogText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    fail("cannot read the log");
  }
}

function parseLogLine(line) {
  try {
    const entry = JSON.parse(line);
    return isObject(entry) && isObject(entry.axes) ? entry : undefined;
  } catch {
    return undefined;
  }
}

function parseLogEntries(logText) {
  const entries = [];
  logText.split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    const entry = parseLogLine(line);
    if (entry) entries.push(entry);
    else process.stderr.write(`deal: skipped corrupt log line ${index + 1}\n`);
  });
  return entries;
}

function hasSameAxes(entry, spec) {
  return AXES.every((axis) => entry.axes[axis] === spec.axes[axis]);
}

function loggedPickId(logEntries, specs, briefSlug) {
  const entry = logEntries.findLast(
    (candidate) =>
      candidate.briefSlug === briefSlug &&
      specs.some((spec) => spec.id === candidate.picked && hasSameAxes(candidate, spec)),
  );
  return entry?.picked ?? null;
}

function typedAxes(spec) {
  return Object.fromEntries(AXES.map((axis) => [axis, spec.axes[axis]]));
}

function collidingAxes(spec, recentEntries, locks) {
  return AXES.filter(
    (axis) =>
      // A brand-fixed value repeats on every run, so it says nothing about variety.
      (locks?.[axis] ?? null) === null &&
      recentEntries.some((entry) => entry.axes[axis] === spec.axes[axis]),
  );
}

function seededDraw(seed) {
  return createHash("sha256").update(seed).digest().readUInt32BE(0) / 2 ** 32;
}

function dealtSpec(specs, collisionsById, seed, tau) {
  const weights = specs.map(
    (spec) =>
      Math.max(spec.typicality, MIN_TYPICALITY) ** (1 / tau) *
      COLLISION_PENALTY ** collisionsById.get(spec.id).length,
  );
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let remaining = seededDraw(seed) * totalWeight;
  for (const [index, weight] of weights.entries()) {
    remaining -= weight;
    if (remaining < 0) return specs[index];
  }
  return specs.at(-1);
}

function appendLogEntry(path, logText, entry) {
  const separator = logText && !logText.endsWith("\n") ? "\n" : "";
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${separator}${JSON.stringify(entry)}\n`);
  } catch {
    fail("cannot write the log");
  }
}

const options = readArguments();
if (!options.specs || !options.log || !options.seed) {
  fail("--specs, --log and --seed are required");
}
const tau = Number(options.tau);
if (!(tau > 0 && Number.isFinite(tau))) fail("--tau must be a positive number");

const directions = readDirections(options.specs);
const { specs, locks, briefSlug } = directions;
const userPick = specs.find((spec) => spec.id === options.pick);
if (options.pick !== undefined && !userPick) fail("--pick names no spec");

refuseSymlinkedLog(options.log);
const logText = readLogText(options.log);
const logEntries = parseLogEntries(logText);
const recentEntries = logEntries.slice(-RECENT_LOG_ENTRIES);
const collisionsById = new Map(
  specs.map((spec) => [spec.id, collidingAxes(spec, recentEntries, locks)]),
);

const allCollide = specs.every((spec) => collisionsById.get(spec.id).length > 0);

function printResult(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (options.check) {
  printResult({
    logged: loggedPickId(logEntries, specs, briefSlug),
    collisions: Object.fromEntries(collisionsById),
    allCollide,
  });
} else {
  const picked = userPick ?? dealtSpec(specs, collisionsById, options.seed, tau);
  const pickedBy = userPick ? "user" : "deal";
  appendLogEntry(options.log, logText, {
    ts: new Date().toISOString(),
    briefSlug,
    picked: picked.id,
    pickedBy,
    axes: typedAxes(picked),
  });
  printResult({ picked: picked.id, pickedBy, collisions: collisionsById.get(picked.id), allCollide });
}
