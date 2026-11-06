import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME_CANDIDATES = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
];
const START_TIMEOUT_MS = 20_000;
const START_POLL_MS = 100;
const COMMAND_TIMEOUT_MS = 60_000;
const LOAD_TIMEOUT_MS = 45_000;
const AFTER_LOAD_SETTLE_MS = 500;
const VIEWPORT_HEIGHT_PX = 900;

export interface PageView {
  screenshot: Buffer;
  consoleErrors: number;
  evaluated: unknown[];
}

interface CdpEvent {
  method?: string;
  sessionId?: string;
  params?: Record<string, unknown>;
}

function chromeBinary(): string {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const name of CHROME_CANDIDATES) {
    try {
      execFileSync("which", [name], { stdio: "ignore" });
      return name;
    } catch {}
  }
  throw new Error("no Chrome found; set CHROME_PATH");
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((done) => setTimeout(done, milliseconds));
}

async function debuggerAddress(profile: string): Promise<string> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const [port, path] = readFileSync(
        join(profile, "DevToolsActivePort"),
        "utf8",
      ).split("\n");
      if (port && path) return `ws://127.0.0.1:${port}${path}`;
    } catch {}
    await wait(START_POLL_MS);
  }
  throw new Error("Chrome did not open its debugging port");
}

class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly listeners = new Set<(event: CdpEvent) => void>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(String(data));
      const waiting = this.pending.get(message.id);
      if (!waiting) {
        for (const listener of this.listeners) listener(message);
        return;
      }
      this.pending.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error.message));
      else waiting.resolve(message.result);
    });
  }

  static open(address: string): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(address);
      socket.addEventListener("open", () => resolve(new CdpConnection(socket)));
      socket.addEventListener("error", () =>
        reject(new Error("could not connect to Chrome")),
      );
    });
  }

  send<Result>(
    method: string,
    params: object = {},
    sessionId?: string,
  ): Promise<Result> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome timed out on ${method}`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as Result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  listen(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.socket.close();
  }
}

async function evaluate(
  connection: CdpConnection,
  sessionId: string,
  expression: string,
): Promise<unknown> {
  const { result, exceptionDetails } = await connection.send<{
    result: { value?: unknown };
    exceptionDetails?: { text: string };
  }>(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  );
  if (exceptionDetails) {
    throw new Error(`script failed in the page: ${exceptionDetails.text}`);
  }
  return result.value;
}

async function withinLoadTimeout(loaded: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`page did not load within ${LOAD_TIMEOUT_MS} ms`)),
      LOAD_TIMEOUT_MS,
    );
  });
  try {
    await Promise.race([loaded, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

async function viewAtWidth(
  connection: CdpConnection,
  url: string,
  width: number,
  expressions: string[],
): Promise<PageView> {
  const { targetId } = await connection.send<{ targetId: string }>(
    "Target.createTarget",
    { url: "about:blank" },
  );
  const { sessionId } = await connection.send<{ sessionId: string }>(
    "Target.attachToTarget",
    { targetId, flatten: true },
  );
  let consoleErrors = 0;
  let onLoad: () => void = () => {};
  const loaded = new Promise<void>((done) => {
    onLoad = done;
  });
  const stopListening = connection.listen((event) => {
    if (event.sessionId !== sessionId) return;
    if (event.method === "Page.loadEventFired") onLoad();
    if (event.method === "Runtime.exceptionThrown") consoleErrors += 1;
    if (
      event.method === "Runtime.consoleAPICalled" &&
      event.params?.type === "error"
    ) {
      consoleErrors += 1;
    }
  });
  try {
    await connection.send("Page.enable", {}, sessionId);
    await connection.send("Runtime.enable", {}, sessionId);
    await connection.send(
      "Emulation.setDeviceMetricsOverride",
      {
        width,
        height: VIEWPORT_HEIGHT_PX,
        deviceScaleFactor: 1,
        mobile: false,
      },
      sessionId,
    );
    // Reveal-on-scroll pages stay blank in a full-page shot unless motion is reduced.
    await connection.send(
      "Emulation.setEmulatedMedia",
      { features: [{ name: "prefers-reduced-motion", value: "reduce" }] },
      sessionId,
    );
    const { errorText } = await connection.send<{ errorText?: string }>(
      "Page.navigate",
      { url },
      sessionId,
    );
    // Chrome still draws an error page here, and it would score as a real, very plain build.
    if (errorText) throw new Error(`page did not load: ${errorText}`);
    await withinLoadTimeout(loaded);
    await evaluate(connection, sessionId, "document.fonts.ready.then(() => 0)");
    await wait(AFTER_LOAD_SETTLE_MS);
    const evaluated: unknown[] = [];
    for (const expression of expressions) {
      evaluated.push(await evaluate(connection, sessionId, expression));
    }
    const { data } = await connection.send<{ data: string }>(
      "Page.captureScreenshot",
      { format: "png", captureBeyondViewport: true },
      sessionId,
    );
    return {
      screenshot: Buffer.from(data, "base64"),
      consoleErrors,
      evaluated,
    };
  } finally {
    stopListening();
    await connection.send("Target.closeTarget", { targetId });
  }
}

export async function renderViews(
  url: string,
  widths: number[],
  expressions: string[],
): Promise<Map<number, PageView>> {
  const profile = mkdtempSync(join(tmpdir(), "agemon-design-eval-chrome-"));
  const chrome = spawn(
    chromeBinary(),
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  try {
    const connection = await CdpConnection.open(await debuggerAddress(profile));
    const views = new Map<number, PageView>();
    for (const width of widths) {
      views.set(width, await viewAtWidth(connection, url, width, expressions));
    }
    connection.close();
    return views;
  } finally {
    chrome.kill();
    await new Promise((done) => chrome.once("exit", done));
    rmSync(profile, { recursive: true, force: true });
  }
}
