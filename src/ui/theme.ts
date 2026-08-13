import pc from "picocolors";

function colorsEnabled(): boolean {
  if (process.env.NO_COLOR) return false;
  return Boolean(process.stdout.isTTY);
}

function colors() {
  return pc.createColors(colorsEnabled());
}

export const theme = {
  success: (text: string) => colors().green(text),
  warn: (text: string) => colors().yellow(text),
  error: (text: string) => colors().red(text),
  info: (text: string) => colors().cyan(text),
  muted: (text: string) => colors().gray(text),
  bold: (text: string) => colors().bold(text),
};
