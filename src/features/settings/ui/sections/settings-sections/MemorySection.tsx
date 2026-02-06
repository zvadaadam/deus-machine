import { useState } from "react";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { SettingRow } from "../../SettingsModal";
import { useClearMemory } from "../../../api/settings.queries";
import type { SettingsSectionProps } from "./types";

export function MemorySection({ settings, saveSetting }: SettingsSectionProps) {
  const [showingConfirmation, setShowingConfirmation] = useState(false);
  const clearMemoryMutation = useClearMemory();

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold">Memory</h3>
        <p className="text-muted-foreground mt-1 text-[13px]">
          Control how conversation context is stored and retained.
        </p>
      </div>

      <div className="space-y-1">
        <SettingRow
          id="conversation-memory"
          label="Conversation memory"
          description="Remember context from previous conversations."
        >
          <Switch
            id="conversation-memory"
            checked={settings.conversation_memory_enabled ?? true}
            onCheckedChange={(checked) => saveSetting("conversation_memory_enabled", checked)}
          />
        </SettingRow>
      </div>

      <div className="space-y-2">
        <Label htmlFor="memory-retention" className="text-sm">
          Memory retention
        </Label>
        <p className="text-muted-foreground text-[13px]">
          How long conversation memory is kept before being cleared.
        </p>
        <Select
          value={settings.memory_retention ?? "session"}
          onValueChange={(value) => saveSetting("memory_retention", value)}
        >
          <SelectTrigger id="memory-retention" className="w-full">
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

      <Separator />

      <div className="space-y-2">
        <p className="text-sm font-medium">Danger zone</p>
        <p className="text-muted-foreground text-[13px]">
          Permanently delete all stored conversation memory.
        </p>
        <Button
          variant="destructive"
          size="sm"
          disabled={clearMemoryMutation.isPending || showingConfirmation}
          onClick={() => {
            setShowingConfirmation(true);
            toast("Are you sure you want to clear all memory?", {
              description: "This action cannot be undone.",
              action: {
                label: "Clear Memory",
                onClick: async () => {
                  try {
                    await clearMemoryMutation.mutateAsync();
                    toast.success("Memory cleared successfully");
                  } catch (error) {
                    console.error("Failed to clear memory:", error);
                    toast.error(
                      `Failed to clear memory: ${error instanceof Error ? error.message : String(error)}`
                    );
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
          Clear all memory
        </Button>
      </div>
    </div>
  );
}
