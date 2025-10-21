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
import { useClearMemory } from '@/hooks/queries';
import type { SettingsSectionProps } from './types';

export function MemorySection({ settings, saveSetting }: SettingsSectionProps) {
  const [showingConfirmation, setShowingConfirmation] = useState(false);
  const clearMemoryMutation = useClearMemory();

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold">Memory Settings</h3>

      <div className="space-y-3">
        <div className="flex items-center space-x-2">
          <Checkbox
            id="conversation-memory"
            checked={(settings as any).conversation_memory_enabled ?? true}
            onCheckedChange={(checked) => saveSetting('conversation_memory_enabled', checked === true)}
          />
          <Label htmlFor="conversation-memory" className="text-sm cursor-pointer">
            Enable conversation memory
          </Label>
        </div>

        <div className="space-y-2">
          <Label htmlFor="memory-retention">Memory retention</Label>
          <Select
            value={(settings as any).memory_retention ?? 'session'}
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
          disabled={clearMemoryMutation.isPending || showingConfirmation}
          onClick={() => {
            setShowingConfirmation(true);
            toast('Are you sure you want to clear all memory?', {
              description: 'This action cannot be undone.',
              action: {
                label: 'Clear Memory',
                onClick: async () => {
                  try {
                    await clearMemoryMutation.mutateAsync();
                    toast.success('Memory cleared successfully');
                  } catch (error) {
                    console.error('Failed to clear memory:', error);
                    toast.error(`Failed to clear memory: ${error instanceof Error ? error.message : String(error)}`);
                  } finally {
                    setShowingConfirmation(false);
                  }
                },
              },
              onDismiss: () => setShowingConfirmation(false),
              onAutoClose: () => setShowingConfirmation(false),
            });
          }}
        >
          Clear All Memory
        </Button>
      </div>
    </div>
  );
}
