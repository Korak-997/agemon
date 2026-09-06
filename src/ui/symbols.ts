export type SymbolName =
  | "ok"
  | "fail"
  | "warn"
  | "pending"
  | "prompt"
  | "arrow"
  | "add"
  | "del"
  | "mod"
  | "adopt"
  | "install"
  | "conflict";

const UNICODE: Record<SymbolName, string> = {
  ok: "✔",
  fail: "✘",
  warn: "⚠",
  pending: "●",
  prompt: "›",
  arrow: "→",
  add: "+",
  del: "-",
  mod: "~",
  adopt: "⇄",
  install: "⤓",
  conflict: "⚑",
};

const ASCII: Record<SymbolName, string> = {
  ok: "[ok]",
  fail: "[x]",
  warn: "[!]",
  pending: "*",
  prompt: ">",
  arrow: "->",
  add: "+",
  del: "-",
  mod: "~",
  adopt: "<>",
  install: "v",
  conflict: "!",
};

function asciiMode(): boolean {
  return Boolean(process.env.NO_COLOR) || !process.stdout.isTTY;
}

export function symbol(name: SymbolName): string {
  return (asciiMode() ? ASCII : UNICODE)[name];
}
