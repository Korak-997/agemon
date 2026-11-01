import type { Command } from "commander";
import type { RootContent } from "mdast";
import { SiteContentError } from "./error.js";
import { code, heading, label, paragraph, table, text } from "./markdown.js";
import { type GeneratedPage, pagePathFromRoute } from "./page.js";

export const COMMANDS_ROUTE = "/reference/commands/";

interface HelpItem {
  term: string;
  description: string;
}

export interface CommandReference {
  title: string;
  summary: string;
  usage: string;
  arguments: HelpItem[];
  options: HelpItem[];
  notes: string;
}

const collapseWhitespace = (value: string): string =>
  value.replace(/\s+/gu, " ").trim();

function textAddedToHelp(command: Command, title: string): string {
  const helpInformation = command.helpInformation();
  let printedHelp = "";
  const previousOutput = { ...command.configureOutput() };
  command.configureOutput({
    writeOut: (chunk) => {
      printedHelp += chunk;
    },
  });
  try {
    command.outputHelp();
  } finally {
    command.configureOutput(previousOutput);
  }
  const start = printedHelp.indexOf(helpInformation);
  if (start === -1) {
    throw new SiteContentError(
      `${title} --help: commander's help layout changed; its output no longer contains helpInformation()`,
    );
  }
  return printedHelp.slice(start + helpInformation.length).trim();
}

function describeCommand(command: Command, title: string): CommandReference {
  const helper = command.createHelp();
  return {
    title,
    summary: helper.commandDescription(command),
    usage: helper.commandUsage(command),
    arguments: helper.visibleArguments(command).map((argument) => ({
      term: helper.argumentTerm(argument),
      description: helper.argumentDescription(argument),
    })),
    options: helper.visibleOptions(command).map((option) => ({
      term: helper.optionTerm(option),
      description: helper.optionDescription(option),
    })),
    notes: textAddedToHelp(command, title),
  };
}

export function describeCommands(program: Command): CommandReference[] {
  const subcommands = program.createHelp().visibleCommands(program);
  return [
    describeCommand(program, program.name()),
    ...subcommands.map((command) =>
      describeCommand(command, `${program.name()} ${command.name()}`),
    ),
  ];
}

function itemTable(termLabel: string, items: HelpItem[]): RootContent {
  return table(
    [termLabel, "Description"],
    items.map((item) => [
      [code(item.term)],
      [text(collapseWhitespace(item.description))],
    ]),
  );
}

function commandSection(reference: CommandReference): RootContent[] {
  const section: RootContent[] = [heading(code(reference.title))];
  if (reference.summary) {
    section.push(paragraph(text(collapseWhitespace(reference.summary))));
  }
  section.push(label("Usage"), {
    type: "code",
    lang: "sh",
    value: reference.usage,
  });
  if (reference.arguments.length > 0) {
    section.push(
      label("Arguments"),
      itemTable("Argument", reference.arguments),
    );
  }
  section.push(label("Options"), itemTable("Flag", reference.options));
  if (reference.notes) {
    section.push(label("Notes"), {
      type: "code",
      lang: "text",
      value: reference.notes,
    });
  }
  return section;
}

export function commandsPage(program: Command, version: string): GeneratedPage {
  return {
    path: pagePathFromRoute(COMMANDS_ROUTE),
    title: "Commands",
    description: "Every agemon command and option, from agemon --help.",
    sidebarOrder: 1,
    provenance: { generatedFrom: "agemon --help" },
    body: [
      paragraph(
        text("Every command and option, as "),
        code("--help"),
        text(` prints them in agemon ${version}.`),
      ),
      ...describeCommands(program).flatMap(commandSection),
    ],
  };
}
