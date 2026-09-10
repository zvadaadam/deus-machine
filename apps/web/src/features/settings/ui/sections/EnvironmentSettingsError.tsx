import { Button } from "@/components/ui/button";

export function EnvironmentSettingsError({ error, retry }: { error: Error; retry: () => void }) {
  return (
    <div role="alert" className="space-y-2">
      <p className="text-destructive text-sm">{error.message}</p>
      <Button size="sm" variant="outline" onClick={retry}>
        Try again
      </Button>
    </div>
  );
}
