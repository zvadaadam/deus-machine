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
 * Follows shadcn composition pattern - wraps but doesn't modify
 * Uses dedicated drag handle instead of making entire item draggable
 */
export function DraggableRepository({
  repository,
  dragDisabled = false,
  ...props
}: DraggableRepositoryProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef, // Separate ref for drag handle
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: repository.repo_id,
    disabled: dragDisabled,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'group/repo', // Enable group hover for drag handle
        isDragging && 'z-50 opacity-50'
      )}
    >
      <RepositoryItem
        repository={repository}
        dragHandleProps={
          !dragDisabled
            ? { setActivatorNodeRef, listeners, attributes }
            : undefined
        }
        {...props}
      />
    </div>
  );
}
