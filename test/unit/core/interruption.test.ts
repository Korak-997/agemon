import { afterEach, describe, expect, it } from "vitest";
import {
  ApplyInterruptedError,
  type InterruptionWatch,
  watchForInterruption,
} from "../../../src/core/interruption.js";

let watch: InterruptionWatch | null = null;

afterEach(() => {
  watch?.dispose();
  watch = null;
});

describe("watchForInterruption", () => {
  it("swallows a failing first-signal report so the signal never throws out of the listener", () => {
    watch = watchForInterruption(
      () => {
        throw Object.assign(new Error("write EIO"), { code: "EIO" });
      },
      () => {},
    );

    expect(() => process.emit("SIGHUP", "SIGHUP")).not.toThrow();
    expect(() => watch?.throwIfInterrupted()).toThrow(ApplyInterruptedError);
  });

  it("removes its listeners on dispose", () => {
    const before = process.listenerCount("SIGINT");
    watch = watchForInterruption(
      () => {},
      () => {},
    );
    expect(process.listenerCount("SIGINT")).toBe(before + 1);

    watch.dispose();
    watch = null;

    expect(process.listenerCount("SIGINT")).toBe(before);
  });
});
