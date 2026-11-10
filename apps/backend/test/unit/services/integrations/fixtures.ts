// Shared fixtures for the integrations tests: an in-memory database with the
// real schema, a small catalog, and a scratch home for skills.

import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { SCHEMA_SQL } from "@shared/schema";
import type { Catalog } from "@shared/integrations/types";

export function memoryDatabase(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}

export function scratchDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function testCatalog(mcpUrl = "https://mcp.example.test/mcp"): Catalog {
  return {
    version: "test",
    apps: [
      {
        id: "linear",
        name: "Linear",
        publisher: "Linear",
        official: true,
        description: "Issues",
        categories: ["developer"],
        transport: { type: "http", url: mcpUrl },
        auth: { kind: "oauth" },
        local: false,
      },
      {
        id: "sentry",
        name: "Sentry",
        publisher: "Sentry",
        official: true,
        description: "Errors",
        categories: ["developer"],
        transport: { type: "http", url: "https://mcp.sentry.test/mcp" },
        auth: { kind: "bearer", label: "Auth token" },
        local: false,
      },
      {
        id: "github",
        name: "GitHub",
        publisher: "GitHub",
        official: true,
        description: "Repos",
        categories: ["developer"],
        transport: { type: "http", url: "https://api.github.test/mcp/" },
        auth: { kind: "bearer", label: "Personal access token", cliToken: "gh" },
        local: false,
      },
      {
        id: "slack",
        name: "Slack",
        publisher: "Slack",
        official: true,
        description: "Chat",
        categories: ["communication"],
        transport: { type: "http", url: "https://mcp.slack.test/mcp" },
        auth: { kind: "oauth", registration: "preregistered" },
        broker: { provider: "composio", toolkit: "slack" },
        local: false,
      },
      {
        id: "voicebox",
        name: "Voicebox",
        publisher: "Voicebox",
        official: true,
        description: "Voices",
        categories: ["creative"],
        transport: { type: "http", url: "https://mcp.voicebox.test/mcp" },
        auth: { kind: "oauth", registration: "preregistered" },
        local: false,
      },
      {
        id: "context7",
        name: "Context7",
        publisher: "Upstash",
        official: true,
        description: "Docs",
        categories: ["developer"],
        transport: { type: "http", url: "https://mcp.context7.test/mcp" },
        auth: { kind: "none" },
        local: false,
      },
      {
        id: "playwright",
        name: "Playwright",
        publisher: "Microsoft",
        official: true,
        description: "Browser",
        categories: ["developer"],
        transport: { type: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest"] },
        auth: { kind: "none" },
        local: true,
      },
      {
        id: "exa",
        name: "Exa",
        publisher: "Exa",
        official: true,
        description: "Search",
        categories: ["data"],
        transport: { type: "stdio", command: "npx", args: ["-y", "exa-mcp-server"] },
        auth: { kind: "env", vars: [{ name: "EXA_API_KEY", label: "API key" }] },
        local: true,
      },
      {
        id: "instagram",
        name: "Instagram",
        publisher: "Meta",
        official: false,
        description: "Posts",
        categories: ["marketing"],
        transport: { type: "broker" },
        auth: { kind: "managed" },
        broker: { provider: "composio", toolkit: "instagram" },
        local: false,
      },
    ],
    skills: [
      {
        id: "acme/plan",
        name: "plan",
        title: "Plan",
        description: "Plans",
        categories: ["developer"],
        publisher: "Acme",
        official: true,
        source: { repo: "acme/skills", ref: "a".repeat(40), path: "skills/plan" },
        requiresApps: ["linear"],
      },
    ],
    plugins: [
      {
        id: "triage",
        title: "Triage",
        tagline: "Triage it",
        description: "Triage it",
        categories: ["developer"],
        publisher: "Deus",
        apps: ["linear", "sentry"],
        skills: [],
      },
      {
        id: "ship",
        title: "Ship",
        tagline: "Ship it",
        description: "Ship it",
        categories: ["developer"],
        publisher: "Deus",
        apps: ["linear", "context7"],
        skills: ["acme/plan"],
      },
    ],
  };
}
