import { useState, useEffect, useRef } from 'react';
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
  // Controlled state for custom endpoint with debounced save
  const [customEndpoint, setCustomEndpoint] = useState(settings.custom_endpoint ?? '');
  const timeoutRef = useRef<NodeJS.Timeout>();

  // Sync with external changes (e.g., from refetch)
  useEffect(() => {
    setCustomEndpoint(settings.custom_endpoint ?? '');
  }, [settings.custom_endpoint]);

  // Debounced save handler
  const handleEndpointChange = (value: string) => {
    setCustomEndpoint(value);
    clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      saveSetting('custom_endpoint', value);
    }, 500);
  };

  // Cleanup timeout on unmount and flush pending changes to prevent data loss
  useEffect(() => {
    return () => {
      // Clear pending timeout
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }

      // Flush any unsaved changes on unmount (e.g., when switching tabs)
      if (customEndpoint !== settings.custom_endpoint) {
        saveSetting('custom_endpoint', customEndpoint);
      }
    };
  }, [customEndpoint, settings.custom_endpoint, saveSetting]);
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
              value={customEndpoint}
              onChange={(e) => handleEndpointChange(e.target.value)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
