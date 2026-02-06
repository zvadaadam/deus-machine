import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import type { SettingsSectionProps } from "./types";

export function AccountSection({ settings, saveSetting }: SettingsSectionProps) {
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold">Account</h3>
        <p className="text-muted-foreground mt-1 text-[13px]">
          Your profile information and API credentials.
        </p>
      </div>

      {/* Profile */}
      <div className="space-y-3">
        <div className="space-y-2">
          <Label htmlFor="user-name" className="text-sm">
            Name
          </Label>
          <Input
            id="user-name"
            defaultValue={settings.user_name ?? ""}
            onBlur={(e) => saveSetting("user_name", e.currentTarget.value)}
            placeholder="Your name"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="user-email" className="text-sm">
            Email
          </Label>
          <Input
            id="user-email"
            type="email"
            defaultValue={settings.user_email ?? ""}
            onBlur={(e) => saveSetting("user_email", e.currentTarget.value)}
            placeholder="your@email.com"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="github-username" className="text-sm">
            GitHub username
          </Label>
          <Input
            id="github-username"
            defaultValue={settings.user_github_username ?? ""}
            onBlur={(e) => saveSetting("user_github_username", e.currentTarget.value)}
            placeholder="github-username"
          />
        </div>
      </div>

      <Separator />

      {/* API Key */}
      <div className="space-y-2">
        <Label htmlFor="api-key" className="text-sm">
          Anthropic API key
        </Label>
        <p className="text-muted-foreground text-[13px]">
          Used for direct API access. Stored locally on your machine.
        </p>
        <Input
          id="api-key"
          type="password"
          defaultValue={settings.anthropic_api_key ?? ""}
          onBlur={(e) => saveSetting("anthropic_api_key", e.currentTarget.value)}
          placeholder="sk-ant-api03-..."
        />
      </div>
    </div>
  );
}
