import { readFile, writeFile } from "node:fs/promises";

function startMarker(blockId: string): string {
  return `<!-- agemon:start:${blockId} -->`;
}

function endMarker(blockId: string): string {
  return `<!-- agemon:end:${blockId} -->`;
}

function normalizeBlockBody(blockBody: string): string {
  return blockBody.replace(/\s+$/u, "");
}

function buildManagedBlock(blockId: string, blockBody: string): string {
  const body = normalizeBlockBody(blockBody);
  if (body.length === 0) {
    return `${startMarker(blockId)}\n${endMarker(blockId)}`;
  }
  return `${startMarker(blockId)}\n${body}\n${endMarker(blockId)}`;
}

function findManagedBlockRange(
  content: string,
  blockId: string,
): {
  start: number;
  end: number;
} | null {
  const start = content.indexOf(startMarker(blockId));
  if (start < 0) {
    return null;
  }

  const endTag = endMarker(blockId);
  const endTagIndex = content.indexOf(endTag, start);
  if (endTagIndex < 0) {
    throw new Error(
      `Found start marker without matching end marker for '${blockId}'.`,
    );
  }

  return { start, end: endTagIndex + endTag.length };
}

export function upsertManagedMarkdownBlock(
  content: string,
  blockId: string,
  blockBody: string,
): { nextContent: string; changed: boolean } {
  const managedBlock = buildManagedBlock(blockId, blockBody);
  const range = findManagedBlockRange(content, blockId);

  if (range) {
    const current = content.slice(range.start, range.end);
    if (current === managedBlock) {
      return { nextContent: content, changed: false };
    }

    const next =
      content.slice(0, range.start) + managedBlock + content.slice(range.end);
    return { nextContent: next, changed: true };
  }

  if (content.length === 0) {
    return { nextContent: `${managedBlock}\n`, changed: true };
  }

  const separator = content.endsWith("\n\n")
    ? ""
    : content.endsWith("\n")
      ? "\n"
      : "\n\n";

  return {
    nextContent: `${content}${separator}${managedBlock}\n`,
    changed: true,
  };
}

export function removeManagedMarkdownBlock(
  content: string,
  blockId: string,
): { nextContent: string; changed: boolean } {
  const range = findManagedBlockRange(content, blockId);
  if (!range) {
    return { nextContent: content, changed: false };
  }

  const before = content.slice(0, range.start);
  const after = content.slice(range.end);

  let next = `${before}${after}`;
  next = next.replace(/\n{3,}/gu, "\n\n");
  if (next === "\n") {
    next = "";
  }

  return { nextContent: next, changed: true };
}

async function readFileOrEmpty(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

export async function upsertManagedMarkdownBlockFile(
  filePath: string,
  blockId: string,
  blockBody: string,
): Promise<boolean> {
  const content = await readFileOrEmpty(filePath);
  const updated = upsertManagedMarkdownBlock(content, blockId, blockBody);
  if (!updated.changed) {
    return false;
  }

  await writeFile(filePath, updated.nextContent, "utf8");
  return true;
}

export async function removeManagedMarkdownBlockFile(
  filePath: string,
  blockId: string,
): Promise<boolean> {
  const content = await readFileOrEmpty(filePath);
  const updated = removeManagedMarkdownBlock(content, blockId);
  if (!updated.changed) {
    return false;
  }

  await writeFile(filePath, updated.nextContent, "utf8");
  return true;
}
