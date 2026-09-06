import { paintTone, type Tone, theme } from "./theme.js";

const MIN_WIDTH = 60;
const MAX_WIDTH = 100;
const DEFAULT_WIDTH = 80;

export function terminalWidth(): number {
  const raw = process.stdout.columns ?? DEFAULT_WIDTH;
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, raw));
}

function badgesRenderAsBlocks(): boolean {
  return !process.env.NO_COLOR && Boolean(process.stdout.isTTY);
}

export function rule(width: number = terminalWidth()): string {
  return theme.dim("─".repeat(width));
}

export function section(title: string): string {
  return `\n${theme.heading(title)}\n${rule()}`;
}

export function indent(text: string, spaces = 2): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? pad + line : line))
    .join("\n");
}

export function bullet(text: string, level = 0): string {
  return `${"  ".repeat(level)}${theme.dim("·")} ${text}`;
}

export function kv(pairs: [string, string][]): string {
  const keyWidth = Math.max(...pairs.map(([key]) => key.length));
  return pairs
    .map(([key, value]) => `${key.padEnd(keyWidth)}  ${value}`)
    .join("\n");
}

export function badge(label: string, tone: Tone = "neutral"): string {
  if (badgesRenderAsBlocks()) {
    return theme.inverse(paintTone(tone, ` ${label} `));
  }
  return `[ ${label} ]`;
}

export interface CountPart {
  n: number;
  label: string;
  tone?: Tone;
}

export function countLine(parts: CountPart[]): string {
  return parts
    .map((part) => paintTone(part.tone ?? "neutral", `${part.n} ${part.label}`))
    .join(theme.dim(" · "));
}
