import {
  defaultRangeExtractor,
  measureElement,
  observeElementOffset,
  useVirtualizer,
  type VirtualItem,
  type Virtualizer,
} from "@tanstack/react-virtual";
import { useCallback, useLayoutEffect, useMemo, useRef, type RefObject } from "react";

type TranscriptVirtualizer = Virtualizer<HTMLDivElement, HTMLDivElement>;

interface HistoryAnchor {
  before: number;
  key: VirtualItem["key"];
  offsetFromTop: number;
  restoredTop?: number;
}

function readAnchor(virtualizer: TranscriptVirtualizer, list: HTMLDivElement, before: number) {
  const pane = virtualizer.scrollElement;
  if (!pane) return null;
  const offset = pane.scrollTop - list.offsetTop;
  const item = virtualizer.getVirtualItemForOffset(offset);
  return item ? { before, key: item.key, offsetFromTop: item.start - offset } : null;
}

export function useTranscriptVirtualizer({
  paneRef,
  count,
  firstSeq,
  estimateSize,
  getItemKey,
  preserveScrollPosition,
  onLoadOlder,
}: {
  paneRef: RefObject<HTMLDivElement>;
  count: number;
  firstSeq: number | undefined;
  estimateSize: (index: number) => number;
  getItemKey: (index: number) => VirtualItem["key"];
  preserveScrollPosition: (restore: () => void) => void;
  onLoadOlder?: () => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const anchor = useRef<HistoryAnchor | null>(null);
  const head = useRef(firstSeq);
  const correction = useRef<number | null>(null);
  const page = anchor.current;
  const prepended = page != null && firstSeq != null && firstSeq < page.before;
  const anchorKey = prepended ? page.key : undefined;
  const anchorIndex = useMemo(() => {
    if (anchorKey == null) return -1;
    for (let i = 0; i < count; i++) {
      if (getItemKey(i) === anchorKey) return i;
    }
    return -1;
  }, [anchorKey, count, getItemKey]);

  const restoreAnchor = useCallback(
    (instance: TranscriptVirtualizer, current: HistoryAnchor) => {
      const pane = instance.scrollElement;
      const content = list.current;
      if (!pane || !content) return;
      if (current.restoredTop != null && current.restoredTop !== pane.scrollTop) return;
      const item = instance.getVirtualItems().find((row) => row.key === current.key);
      if (!item) {
        anchor.current = null;
        return;
      }

      content.style.height = `${instance.getTotalSize()}px`;
      const max = Math.max(0, pane.scrollHeight - pane.clientHeight);
      const offset = content.offsetTop + item.start - current.offsetFromTop;
      const top = Math.min(max, Math.max(0, offset));
      if (current.restoredTop == null || Math.abs(pane.scrollTop - top) >= 1) {
        preserveScrollPosition(() => instance.scrollToOffset(top));
      }
      current.restoredTop = pane.scrollTop;
      if (max === 0) anchor.current = null;
    },
    [preserveScrollPosition]
  );

  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count,
    getScrollElement: () => paneRef.current,
    estimateSize,
    overscan: 8,
    getItemKey,
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range);
      if (anchorIndex < 0 || indexes.includes(anchorIndex)) return indexes;
      return [...indexes, anchorIndex].sort((a, b) => a - b);
    },
    observeElementOffset(instance, report) {
      return observeElementOffset(instance, (offset, scrolling) => {
        const current = anchor.current;
        if (scrolling && current && list.current) {
          if (current.restoredTop != null) {
            if (offset !== current.restoredTop) anchor.current = null;
          } else if (head.current === current.before) {
            // Follow the reader while the older page is in flight.
            anchor.current = readAnchor(instance, list.current, current.before);
          }
        }
        report(offset, scrolling);
      });
    },
    onChange(instance, scrolling) {
      const current = anchor.current;
      if (scrolling || current?.restoredTop == null || correction.current != null) return;
      // Restore from the updated measurements once per frame, even before TanStack
      // has received the scroll event for the first restoration.
      correction.current = requestAnimationFrame(() => {
        correction.current = null;
        if (anchor.current === current) restoreAnchor(instance, current);
      });
    },
    measureElement(element, entry, instance) {
      instance.shouldAdjustScrollPositionOnItemSizeChange = (item, delta) => {
        const pane = instance.scrollElement;
        const content = list.current;
        if (!pane || !content || (anchor.current && anchorIndex >= 0)) return false;
        if (content.offsetTop + item.end > pane.scrollTop) return false;
        // TanStack applies the correction before it publishes the new measured size.
        content.style.height = `${instance.getTotalSize() + delta}px`;
        return true;
      };
      return measureElement(element, entry, instance);
    },
  });

  useLayoutEffect(() => {
    head.current = firstSeq;
    if (prepended && anchor.current === page && page.restoredTop == null) {
      restoreAnchor(virtualizer, page);
    }
  }, [firstSeq, page, prepended, restoreAnchor, virtualizer]);

  useLayoutEffect(
    () => () => {
      if (correction.current != null) cancelAnimationFrame(correction.current);
      correction.current = null;
    },
    []
  );

  function loadOlder() {
    if (firstSeq != null && list.current)
      anchor.current = readAnchor(virtualizer, list.current, firstSeq);
    onLoadOlder?.();
  }

  return {
    list,
    listHeight: virtualizer.getTotalSize(),
    items: virtualizer.getVirtualItems(),
    measure: virtualizer.measureElement,
    loadOlder,
  };
}
