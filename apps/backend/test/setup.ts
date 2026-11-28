import Database from "better-sqlite3";
import { vi, afterEach } from "vitest";

// better-sqlite3@13 lazily resolves prebuilds/${process.platform}-${process.arch}.node
// on the first Database construction. Load and cache the real binding once per worker
// before any test stubs process.platform or process.arch.
new Database(":memory:").close();

afterEach(() => {
  vi.restoreAllMocks();
});

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
