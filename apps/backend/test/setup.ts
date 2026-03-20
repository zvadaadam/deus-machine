import { vi, afterEach } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
});

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
