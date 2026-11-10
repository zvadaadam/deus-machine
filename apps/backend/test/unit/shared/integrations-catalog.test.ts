import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { CATALOG } from "@shared/integrations/catalog";
import { INTEGRATION_ICON_ID, INTEGRATION_ICONS } from "@shared/integrations/icons";
import { CatalogSchema } from "@shared/integrations/types";

describe("the shipped catalog", () => {
  it("parses with the catalog schema", () => {
    expect(() => CatalogSchema.parse(CATALOG)).not.toThrow();
  });

  it("has unique ids, and unique skill folder names", () => {
    const unique = (values: string[]) => new Set(values).size === values.length;
    expect(unique(CATALOG.apps.map((a) => a.id))).toBe(true);
    expect(unique(CATALOG.skills.map((s) => s.id))).toBe(true);
    // Two skills with one name would land in the same ~/.claude/skills folder.
    expect(unique(CATALOG.skills.map((s) => s.name))).toBe(true);
    expect(unique(CATALOG.plugins.map((p) => p.id))).toBe(true);
  });

  it("pins every skill to a commit", () => {
    for (const skill of CATALOG.skills)
      expect(skill.source.ref, skill.id).toMatch(/^[0-9a-f]{40}$/);
  });

  it("plugins and skills refer only to items in the catalog", () => {
    const apps = new Set(CATALOG.apps.map((a) => a.id));
    const skills = new Set(CATALOG.skills.map((s) => s.id));
    for (const plugin of CATALOG.plugins) {
      expect(plugin.skills.length, plugin.id).toBeGreaterThan(0);
      for (const id of plugin.apps) expect(apps.has(id), `${plugin.id} → app ${id}`).toBe(true);
      for (const id of plugin.skills)
        expect(skills.has(id), `${plugin.id} → skill ${id}`).toBe(true);
    }
    for (const skill of CATALOG.skills) {
      for (const id of skill.requiresApps)
        expect(apps.has(id), `${skill.id} → app ${id}`).toBe(true);
    }
  });

  it("every icon key has a generated mark (run scripts/generate-integration-icons.ts)", () => {
    for (const app of CATALOG.apps) {
      if (app.icon) expect(INTEGRATION_ICONS[app.icon], app.id).toBeDefined();
    }
  });

  it("remote apps use https, except desktop apps on this computer", () => {
    for (const app of CATALOG.apps) {
      if (app.transport.type === "stdio") {
        expect(app.local, app.id).toBe(true);
        continue;
      }
      if (app.transport.type === "broker") continue;
      const url = new URL(app.transport.url);
      if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
        expect(app.local, app.id).toBe(true);
      } else {
        expect(url.protocol, app.id).toBe("https:");
      }
    }
  });

  it("an OAuth app runs remotely (OAuth needs a server to sign in to)", () => {
    for (const app of CATALOG.apps) {
      if (app.auth.kind === "oauth") expect(app.transport.type, app.id).not.toBe("stdio");
    }
  });

  it("an app with no server of its own names the broker that serves it", () => {
    for (const app of CATALOG.apps) {
      const brokerOnly = app.transport.type === "broker";
      expect(app.auth.kind === "managed", app.id).toBe(brokerOnly);
      if (brokerOnly) expect(app.broker, app.id).toBeDefined();
    }
  });

  it("a broker route is only where an app needs one", () => {
    // An app that signs in by itself (a key, or a client registered on the
    // spot) never takes the broker: a route on it would be dead data.
    for (const app of CATALOG.apps) {
      if (!app.broker) continue;
      const gated = app.auth.kind === "oauth" && app.auth.registration === "preregistered";
      expect(gated || app.auth.kind === "managed", app.id).toBe(true);
      expect(app.broker.provider, app.id).toBe("composio");
      expect(app.broker.toolkit, app.id).toMatch(/^[a-z0-9_]+$/);
    }
  });
});

describe("the generated marks", () => {
  const marks = Object.entries(INTEGRATION_ICONS);

  it("are only the ones the catalog draws", () => {
    const drawn = new Set<string>();
    for (const app of CATALOG.apps) if (app.icon) drawn.add(app.icon);
    expect(Object.keys(INTEGRATION_ICONS).sort()).toEqual([...drawn].sort());
  });

  // The web app sets a body as markup, so a body is shapes and paints: no
  // script, no handler, no style, nothing fetched from outside the mark.
  it("hold shapes and paints only", () => {
    const allowed = new Set([
      "path",
      "circle",
      "ellipse",
      "rect",
      "polygon",
      "polyline",
      "line",
      "use",
      "g",
      "defs",
      "linearGradient",
      "radialGradient",
      "stop",
      "mask",
      "clipPath",
    ]);
    for (const [key, mark] of marks) {
      expect(mark.viewBox, key).toMatch(/^0 0 [\d.]+ [\d.]+$/);
      for (const [, tag, attributes] of mark.body.matchAll(/<\/?([a-zA-Z]+)([^>]*)>/g)) {
        expect(allowed.has(tag!), `${key} <${tag}>`).toBe(true);
        for (const [, attribute, value] of attributes!.matchAll(/([a-zA-Z:-]+)="([^"]*)"/g)) {
          expect(attribute, key).not.toMatch(/^on|^style$/i);
          expect(value, `${key} ${attribute}`).not.toMatch(/url\((?!#)|javascript:|data:/i);
          if (attribute!.endsWith("href")) expect(value, key).toMatch(/^#/);
        }
      }
    }
  });

  // One page shows a mark many times. Ids that all start with the shared
  // prefix can be made each copy's own, so no copy paints with another's
  // gradient.
  it("prefix every id, and point only at their own ids", () => {
    for (const [key, mark] of marks) {
      const ids = [...mark.body.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]!);
      expect(new Set(ids).size, key).toBe(ids.length);
      for (const id of ids) expect(id.startsWith(INTEGRATION_ICON_ID), `${key} #${id}`).toBe(true);
      for (const [, target] of mark.body.matchAll(/(?:url\(|href=")#([^)"]+)/g)) {
        expect(ids, `${key} → #${target}`).toContain(target);
      }
    }
  });

  it("name an ink exactly where they draw in the current colour", () => {
    for (const [key, mark] of marks) {
      expect(mark.body.includes("currentColor"), key).toBe(mark.ink !== undefined);
      if (mark.ink) expect(mark.ink, key).toMatch(/^#[0-9a-f]{6}$/);
      if (mark.textColorIn) expect(mark.ink, key).toBeDefined();
    }
  });
});

describe("the catalog is data", () => {
  // The catalog and its types travel: the web app, the backend, and next
  // Deus Cloud's gateway read the same entries. So they depend on nothing
  // but zod and each other, and an app is never implemented here — an entry
  // points at someone else's server, a package to run, or a broker.
  it("imports nothing outside shared/integrations but zod", () => {
    const root = path.resolve(__dirname, "../../../../../shared/integrations");
    const files = fs
      .readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const source = fs.readFileSync(path.join(root, file), "utf8");
      for (const [, specifier] of source.matchAll(/from\s+"([^"]+)"/g)) {
        if (specifier === "zod") continue;
        expect(specifier, file).toMatch(/^\.\.?\//);
        const resolved = path.resolve(path.dirname(path.join(root, file)), specifier!);
        expect(resolved.startsWith(root), `${file} → ${specifier}`).toBe(true);
      }
    }
  });
});
