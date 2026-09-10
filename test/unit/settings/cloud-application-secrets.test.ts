import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProjectEnvironment } from "@deus-hq/api";
import { describe, expect, it, vi } from "vitest";
import { CloudApplicationSecrets } from "@/features/settings/ui/sections/CloudApplicationSecrets";
import type { CloudEnvironmentSettings } from "@shared/types/environment-secrets";

vi.mock("@/features/settings/ui/sections/EnvironmentSecretDialog", () => ({
  EnvironmentSecretDialog: () => null,
}));
vi.mock("@/features/settings/ui/sections/ImportEnvironmentSecretsDialog", () => ({
  ImportEnvironmentSecretsDialog: () => null,
}));

function render(
  project: ProjectEnvironment | undefined,
  secrets: CloudEnvironmentSettings["secrets"] = [],
  required: CloudEnvironmentSettings["required"] = []
) {
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(CloudApplicationSecrets, {
        orgId: "org",
        environmentId: "environment",
        settings: {
          accountId: "account",
          organizationId: "org",
          canManageShared: true,
          selectedEnvironment: null,
          environments: [],
          secrets,
          required,
        },
        project,
        onDefaults: () => {},
      })
    )
  );
}

describe("cloud required-variable status", () => {
  it("uses SDK requirements only when no project recipe is supplied", () => {
    const required: CloudEnvironmentSettings["required"] = [
      { name: "SDK_REQUIRED", source: null, secretId: null },
    ];
    const sdk = render(undefined, [], required);
    expect(sdk).toContain("SDK_REQUIRED");
    expect(sdk).toContain("1 missing");
    expect(sdk).toContain("Set value");

    const emptyProject = render({ version: 1, requiredEnv: [] }, [], required);
    expect(emptyProject).not.toContain("Required values");
    expect(emptyProject).not.toContain("SDK_REQUIRED");
  });

  it.each(["constructor", "toString", "__proto__"])(
    "requires an actual value for %s instead of inheriting Object.prototype",
    (name) => {
      const missing = render({ version: 1, requiredEnv: [name] });
      expect(missing).toContain("1 missing");
      expect(missing).toContain("Set value");
      expect(missing).not.toContain("Set in recipe");

      const configured = render({
        version: 1,
        requiredEnv: [name],
        env: { [name]: "public-default" },
      });
      expect(configured).toContain("All values set");
      expect(configured).toContain("Set in recipe");
    }
  );

  it("leaves an empty cloud override missing until a secret applies to this repository", () => {
    const project: ProjectEnvironment = {
      version: 1,
      requiredEnv: ["APP_KEY"],
      env: { APP_KEY: "public-default" },
      cloud: { env: { APP_KEY: "" } },
    };
    const secret = {
      id: "secret",
      name: "APP_KEY",
      ownerType: "USER" as const,
      userId: "account",
      appliesToAll: false,
      environmentIds: ["another-environment"],
    };
    expect(render(project, [secret])).toContain("1 missing");

    const configured = render(project, [{ ...secret, environmentIds: ["environment"] }]);
    expect(configured).toContain("All values set");
    expect(configured).not.toContain("Set in recipe");
  });
});
