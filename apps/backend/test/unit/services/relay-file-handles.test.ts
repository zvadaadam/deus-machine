import { afterEach, expect, it, vi } from "vitest";
import { statSync } from "node:fs";
import { FileHandles } from "../../../src/services/relay-file-handles";

const stat = statSync(import.meta.filename);
const source = { kind: "recording" as const, path: "/tmp/recording.mp4" };
const file = { source, realPath: source.path, type: "video/mp4", stat };
afterEach(() => vi.useRealTimers());

it("binds the link to the device and file for one hour or until revocation or process restart", () => {
  vi.useFakeTimers();
  const handles = new FileHandles();
  const first = handles.issue("phone", file);
  const second = handles.issue("tablet", file);
  expect(first).not.toBe(second);
  expect(handles.issue("phone", file)).toBe(first);
  handles.revoke("phone");
  expect(handles.lookup(first)).toBeUndefined();
  expect(handles.lookup(second)?.deviceId).toBe("tablet");
  vi.advanceTimersByTime(3_600_000);
  expect(handles.lookup(second)).toBeUndefined();
  const fresh = handles.issue("tablet", file);
  expect(fresh).not.toBe(second);
  const restarted = new FileHandles();
  expect(restarted.routeKey).not.toBe(handles.routeKey);
  expect(restarted.lookup(fresh)).toBeUndefined();
});

it("preserves issued links at capacity and reuses slots after expiry", () => {
  vi.useFakeTimers();
  const handles = new FileHandles();
  const first = handles.issue("0", file);
  for (let i = 1; i < 1024; i++) handles.issue(String(i), file);
  expect(() => handles.issue("overflow", file)).toThrow(/Too many/);
  expect(handles.issue("0", file)).toBe(first);
  vi.advanceTimersByTime(3_600_000);
  expect(handles.issue("overflow", file)).toHaveLength(22);
});
