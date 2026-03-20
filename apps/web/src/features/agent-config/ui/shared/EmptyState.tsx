/**
 * Empty state placeholder shown when a category has no items.
 */

interface EmptyStateProps {
  category: string;
}

export function EmptyState({ category }: EmptyStateProps) {
  return (
    <div className="border-border/40 text-muted-foreground bg-muted/30 rounded-lg border border-dashed px-4 py-8 text-center text-xs">
      <p>No {category} configured</p>
    </div>
  );
}
