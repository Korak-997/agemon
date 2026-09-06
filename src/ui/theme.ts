import pc from "picocolors";

function colorsEnabled(): boolean {
  if (process.env.NO_COLOR) return false;
  return Boolean(process.stdout.isTTY);
}

function colors() {
  return pc.createColors(colorsEnabled());
}

export type Tone = "ok" | "warn" | "danger" | "accent" | "dim" | "neutral";

export const theme = {
  heading: (text: string) => colors().bold(text),
  dim: (text: string) => colors().gray(text),
  accent: (text: string) => colors().cyan(text),
  ok: (text: string) => colors().green(text),
  warn: (text: string) => colors().yellow(text),
  danger: (text: string) => colors().red(text),
  added: (text: string) => colors().green(text),
  removed: (text: string) => colors().red(text),
  inverse: (text: string) => colors().inverse(text),
};

export function paintTone(tone: Tone, text: string): string {
  switch (tone) {
    case "ok":
      return theme.ok(text);
    case "warn":
      return theme.warn(text);
    case "danger":
      return theme.danger(text);
    case "accent":
      return theme.accent(text);
    case "dim":
      return theme.dim(text);
    case "neutral":
      return text;
  }
}
