import boxen from "boxen";
import { theme } from "./theme.js";

export function renderBanner(title: string, message: string): string {
  return boxen(`${theme.heading(title)}\n\n${message}`, {
    padding: 1,
    borderColor: "cyan",
    borderStyle: "round",
  });
}
