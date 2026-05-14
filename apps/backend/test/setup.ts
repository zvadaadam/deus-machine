import { vi, afterEach } from "vitest";

vi.mock("@sentry/node", () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  close: vi.fn(() => Promise.resolve(true)),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
