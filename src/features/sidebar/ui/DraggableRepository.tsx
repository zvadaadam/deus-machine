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
 * Uses dedicated drag handle area - clicks work normally
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
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: repository.repo_id,
    disabled: dragDisabled,
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
      className={cn(isDragging && 'z-50 opacity-50')}
    >
      <RepositoryItem
        repository={repository}
        isCollapsed={isCollapsed}
        onToggleCollapse={onToggleCollapse}
        dragHandleProps={!dragDisabled ? {
          attributes,
          listeners,
          setActivatorNodeRef,
        } : undefined}
        {...props}
      />
    </div>
  );
}
