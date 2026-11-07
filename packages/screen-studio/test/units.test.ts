import { describe, expect, it } from "vitest";
import { JpegSplitter, jpegSize } from "../src/util/jpeg.js";
import { parseBytes, parseDuration, parseSize } from "../src/util/units.js";
import { jpegFrames } from "./helpers.js";

describe("units", () => {
  it("parses durations, bare numbers as seconds", () => {
    expect(parseDuration("1500ms")).toBe(1500);
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("2.5m")).toBe(150_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration("45")).toBe(45_000);
    expect(parseDuration(2)).toBe(2000);
    expect(() => parseDuration("soon")).toThrow(/Invalid duration/);
  });

  it("parses sizes and byte counts", () => {
    expect(parseSize("1920x1080")).toEqual({ width: 1920, height: 1080 });
    expect(() => parseSize("10x10")).toThrow();
    expect(parseBytes("1GiB")).toBe(1024 ** 3);
    expect(parseBytes("500MB")).toBe(500_000_000);
    expect(() => parseBytes("lots")).toThrow(
      expect.objectContaining({ code: "invalid_argument", hint: "Examples: 500MB, 2GiB" })
    );
  });
});

describe("JPEG stream splitting", () => {
  const frames = jpegFrames(4);

  it("recovers every frame regardless of chunk boundaries", () => {
    const stream = Buffer.concat(frames);
    for (const chunkSize of [1, 7, 333, stream.length]) {
      const splitter = new JpegSplitter();
      const out: Buffer[] = [];
      for (let i = 0; i < stream.length; i += chunkSize)
        out.push(...splitter.push(stream.subarray(i, i + chunkSize)));
      expect(out.map((f) => f.length)).toEqual(frames.map((f) => f.length));
      expect(splitter.pendingBytes).toBe(0);
    }
  });

  it("reads dimensions without decoding", () => {
    expect(jpegSize(frames[0])).toEqual({ width: 64, height: 48 });
  });
});
