import { vi, afterEach } from "vitest";

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
  close: vi.fn(() => Promise.resolve()),
  init: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
