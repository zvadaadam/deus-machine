import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import type { SettingsSectionProps } from "./types";

export function AccountSection({ settings, saveSetting }: SettingsSectionProps) {
  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold">Account Settings</h3>

      <div className="space-y-3">
        <div className="space-y-2">
          <Label htmlFor="user-name">Name</Label>
          <Input
            id="user-name"
            defaultValue={settings.user_name ?? ""}
            onBlur={(e) => saveSetting("user_name", e.currentTarget.value)}
            placeholder="Your name"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="user-email">Email</Label>
          <Input
            id="user-email"
            type="email"
            defaultValue={settings.user_email ?? ""}
            onBlur={(e) => saveSetting("user_email", e.currentTarget.value)}
            placeholder="your@email.com"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="github-username">GitHub Username</Label>
          <Input
            id="github-username"
            defaultValue={settings.user_github_username ?? ""}
            onBlur={(e) => saveSetting("user_github_username", e.currentTarget.value)}
            placeholder="github-username"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="api-key">Anthropic API Key</Label>
          <Input
            id="api-key"
            type="password"
            defaultValue={settings.anthropic_api_key ?? ""}
            onBlur={(e) => saveSetting("anthropic_api_key", e.currentTarget.value)}
            placeholder="sk-ant-api03-..."
          />
        </div>
      </div>
    </div>
  );
}
