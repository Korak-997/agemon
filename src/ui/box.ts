import boxen from "boxen";
import { paintTone, type Tone } from "./theme.js";

export interface BoxInput {
  title?: string;
  body: string;
  tone?: Tone;
}

export function box(input: BoxInput): string {
  const tone = input.tone ?? "accent";
  const borderColor =
    tone === "ok"
      ? "green"
      : tone === "warn"
        ? "yellow"
        : tone === "danger"
          ? "red"
          : "cyan";

  return boxen(input.body, {
    title: input.title ? paintTone(tone, input.title) : undefined,
    padding: 1,
    borderColor,
    borderStyle: "round",
  });
}
