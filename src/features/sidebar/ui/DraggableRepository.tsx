import { useEffect } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { cn } from '@/shared/lib/utils';
import type { RepositoryItemProps } from '../model/types';
import { RepositoryItem } from './RepositoryItem';

interface DraggableRepositoryProps extends RepositoryItemProps {
  dragDisabled?: boolean;
}

/**
 * Draggable wrapper for RepositoryItem
 * Entire row is draggable with small distance threshold
 * Grip icon is visual indicator only
 * Auto-collapses on drag start (Linear pattern) for better drag experience
 */
export function DraggableRepository({
  repository,
  isCollapsed,
  onToggleCollapse,
  dragDisabled = false,
  ...props
}: DraggableRepositoryProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: repository.repo_id,
    disabled: dragDisabled,
    // Small distance threshold: clicks register instantly, drags need 8px movement
    activationConstraint: {
      distance: 8,
    },
  });

  // Auto-collapse when drag starts (prevents huge drag preview with many workspaces)
  useEffect(() => {
    if (isDragging && !isCollapsed) {
      onToggleCollapse();
    }
  }, [isDragging, isCollapsed, onToggleCollapse]);

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...(!dragDisabled ? { ...attributes, ...listeners } : {})}
      className={cn(isDragging && 'z-50 opacity-50')}
    >
      <RepositoryItem
        repository={repository}
        isCollapsed={isCollapsed}
        onToggleCollapse={onToggleCollapse}
        showGripIcon={!dragDisabled}
        {...props}
      />
    </div>
  );
}
