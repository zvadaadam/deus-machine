import { useState } from 'react';
import { toast } from 'sonner';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { getBaseURL } from '@/config/api.config';
import type { SettingsSectionProps } from './types';

export function MemorySection({ settings, saveSetting }: SettingsSectionProps) {
  const [clearing, setClearing] = useState(false);

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold">Memory Settings</h3>

      <div className="space-y-3">
        <div className="flex items-center space-x-2">
          <Checkbox
            id="conversation-memory"
            checked={settings.conversation_memory_enabled ?? true}
            onCheckedChange={(checked) => saveSetting('conversation_memory_enabled', checked === true)}
          />
          <Label htmlFor="conversation-memory" className="text-sm cursor-pointer">
            Enable conversation memory
          </Label>
        </div>

        <div className="space-y-2">
          <Label htmlFor="memory-retention">Memory retention</Label>
          <Select
            value={settings.memory_retention ?? 'session'}
            onValueChange={(value) => saveSetting('memory_retention', value)}
          >
            <SelectTrigger id="memory-retention">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="session">Current session only</SelectItem>
              <SelectItem value="day">24 hours</SelectItem>
              <SelectItem value="week">7 days</SelectItem>
              <SelectItem value="forever">Forever</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Button
          variant="secondary"
          size="sm"
          disabled={clearing}
          onClick={() => {
            toast('Are you sure you want to clear all memory?', {
              description: 'This action cannot be undone.',
              action: {
                label: 'Clear Memory',
                onClick: async () => {
                  try {
                    setClearing(true);
                    const baseURL = await getBaseURL();
                    const response = await fetch(`${baseURL}/memory/clear`, { method: 'POST' });
                    if (!response.ok) throw new Error(`Failed to clear memory: ${response.status}`);
                    toast.success('Memory cleared successfully');
                  } catch (error) {
                    console.error('Failed to clear memory:', error);
                    toast.error(`Failed to clear memory: ${error instanceof Error ? error.message : String(error)}`);
                  } finally {
                    setClearing(false);
                  }
                },
              },
            });
          }}
        >
          Clear All Memory
        </Button>
      </div>
    </div>
  );
}
