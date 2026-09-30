import { expect, it } from "vitest";
import { repositorySlug, routingTarget } from "@/features/settings/lib/slack-routing";

it("reads a repository URL as owner/name", () => {
  expect(repositorySlug("https://github.com/acme/backend.git")).toBe("acme/backend");
  expect(repositorySlug("https://gitlab.com/acme/tools/cli/")).toBe("acme/tools/cli");
  expect(repositorySlug("acme/backend")).toBe("acme/backend");
  expect(repositorySlug(null)).toBeNull();
});

it("targets the repository, or the environment when the repository doesn't tell it apart", () => {
  const backend = { id: "a", name: "Backend", repo: "https://github.com/acme/backend" };
  const staging = { id: "b", name: "qapp-staging", repo: "https://github.com/acme/qapp" };
  const prod = { id: "c", name: "qapp-prod", repo: "https://github.com/acme/qapp.git" };
  const scratch = { id: "d", name: "Scratch", repo: null };
  const shared = [backend, staging, prod, scratch];

  expect(routingTarget(backend, shared)).toEqual({ label: "acme/backend", detail: null });
  expect(routingTarget(staging, shared)).toEqual({ label: "qapp-staging", detail: "acme/qapp" });
  expect(routingTarget(scratch, shared)).toEqual({ label: "Scratch", detail: null });
});

it("tells environments apart when their remotes name one repository differently", () => {
  const ssh = { id: "a", name: "app-staging", repo: "git@github.com:Acme/App.git" };
  const https = { id: "b", name: "app-prod", repo: "https://github.com/acme/app" };
  expect(repositorySlug(ssh.repo)).toBe("Acme/App");
  expect(routingTarget(ssh, [ssh, https])).toEqual({ label: "app-staging", detail: "Acme/App" });
  expect(routingTarget(https, [ssh, https])).toEqual({ label: "app-prod", detail: "acme/app" });
});
