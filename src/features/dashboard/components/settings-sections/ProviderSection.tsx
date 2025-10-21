import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { SettingsSectionProps } from './types';

export function ProviderSection({ settings, saveSetting }: SettingsSectionProps) {
  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold">Provider Settings</h3>

      <div className="space-y-3">
        <div className="space-y-2">
          <Label htmlFor="provider">Provider</Label>
          <Select
            value={settings.claude_provider ?? 'anthropic'}
            onValueChange={(value) => saveSetting('claude_provider', value)}
          >
            <SelectTrigger id="provider">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="anthropic">Anthropic (Official)</SelectItem>
              <SelectItem value="custom">Custom Endpoint</SelectItem>
              <SelectItem value="bedrock">AWS Bedrock</SelectItem>
              <SelectItem value="vertex">Google Vertex AI</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="model">Default Model</Label>
          <Select
            value={settings.claude_model ?? 'sonnet'}
            onValueChange={(value) => saveSetting('claude_model', value)}
          >
            <SelectTrigger id="model">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="sonnet">Claude 3.5 Sonnet</SelectItem>
              <SelectItem value="opus">Claude 3 Opus</SelectItem>
              <SelectItem value="haiku">Claude 3.5 Haiku</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {settings.claude_provider === 'custom' && (
          <div className="space-y-2">
            <Label htmlFor="custom-endpoint">Custom Endpoint URL</Label>
            <Input
              id="custom-endpoint"
              type="url"
              placeholder="https://api.example.com/v1"
              defaultValue={(settings as any).custom_endpoint ?? ''}
              onBlur={(e) => saveSetting('custom_endpoint', e.currentTarget.value)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
