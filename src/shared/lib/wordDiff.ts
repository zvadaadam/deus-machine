/**
 * Word-Level Diff Algorithm (Optimized)
 *
 * Fast word-based diff instead of character-level LCS
 * 10-100x faster than full character-level dynamic programming
 *
 * Used by DiffViewer to show saturated backgrounds on changed words,
 * GitHub-style visual emphasis on what actually changed.
 */

/**
 * Character range that should be highlighted
 */
export interface HighlightRange {
  start: number;
  end: number;
}

/**
 * Fast word-based tokenization with position tracking
 * Split on word boundaries instead of every character
 */
function tokenizeWords(text: string): { words: string[]; positions: number[] } {
  const words: string[] = [];
  const positions: number[] = [];
  let currentWord = "";
  let currentPos = 0;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const isWordChar = /\w/.test(char);

    if (isWordChar) {
      if (currentWord === "") {
        currentPos = i;
      }
      currentWord += char;
    } else {
      if (currentWord) {
        words.push(currentWord);
        positions.push(currentPos);
        currentWord = "";
      }
      // Treat each non-word char as its own token (for punctuation changes)
      words.push(char);
      positions.push(i);
    }
  }

  if (currentWord) {
    words.push(currentWord);
    positions.push(currentPos);
  }

  return { words, positions };
}

/**
 * Fast Set-based word diff
 * Much faster than full LCS for typical code changes
 */
function computeWordLCS(oldWords: string[], newWords: string[]): [Set<number>, Set<number>] {
  const oldInLCS = new Set<number>();
  const newInLCS = new Set<number>();

  // Simple greedy matching: walk both arrays, mark matches
  let oldIdx = 0;
  let newIdx = 0;

  while (oldIdx < oldWords.length && newIdx < newWords.length) {
    if (oldWords[oldIdx] === newWords[newIdx]) {
      // Same word, mark as common
      oldInLCS.add(oldIdx);
      newInLCS.add(newIdx);
      oldIdx++;
      newIdx++;
    } else {
      // Different - try to find a match nearby
      let foundMatch = false;

      // Look ahead in new array for old word
      for (let i = newIdx + 1; i < Math.min(newIdx + 5, newWords.length); i++) {
        if (newWords[i] === oldWords[oldIdx]) {
          // Found match ahead, skip items in new array
          newIdx = i;
          foundMatch = true;
          break;
        }
      }

      if (!foundMatch) {
        // Look ahead in old array for new word
        for (let i = oldIdx + 1; i < Math.min(oldIdx + 5, oldWords.length); i++) {
          if (oldWords[i] === newWords[newIdx]) {
            // Found match ahead, skip items in old array
            oldIdx = i;
            foundMatch = true;
            break;
          }
        }
      }

      if (!foundMatch) {
        // No match found nearby, skip both
        oldIdx++;
        newIdx++;
      }
    }
  }

  return [oldInLCS, newInLCS];
}

/**
 * Find character ranges that differ based on word-level diff
 */
function findDiffRanges(
  words: string[],
  positions: number[],
  lcsIndices: Set<number>
): HighlightRange[] {
  const ranges: HighlightRange[] = [];

  for (let i = 0; i < words.length; i++) {
    if (!lcsIndices.has(i)) {
      const start = positions[i];
      const end = start + words[i].length;
      ranges.push({ start, end });
    }
  }

  // Merge adjacent/overlapping ranges
  return mergeAdjacentRanges(ranges);
}

/**
 * Merge ranges that are very close together
 * This prevents highlighting individual characters with gaps
 */
function mergeAdjacentRanges(ranges: HighlightRange[]): HighlightRange[] {
  if (ranges.length === 0) return [];

  // Sort by start position
  ranges.sort((a, b) => a.start - b.start);

  const merged: HighlightRange[] = [ranges[0]];

  for (let i = 1; i < ranges.length; i++) {
    const current = ranges[i];
    const last = merged[merged.length - 1];

    // Merge if overlapping or gap is 2 chars or less (punctuation + space)
    if (current.start <= last.end + 2) {
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push(current);
    }
  }

  return merged;
}

/**
 * Compute word-level diff between two text strings
 * Returns highlight ranges for both old and new text
 *
 * Optimized for performance:
 * - Word-based tokenization (not character-level)
 * - Fast Set-based diff (not full LCS dynamic programming)
 * - 10-100x faster than character-level LCS
 */
export function computeWordDiff(
  oldText: string,
  newText: string
): {
  oldRanges: HighlightRange[];
  newRanges: HighlightRange[];
} {
  // Early exit for identical strings
  if (oldText === newText) {
    return { oldRanges: [], newRanges: [] };
  }

  // Tokenize into words with positions
  const oldTokens = tokenizeWords(oldText);
  const newTokens = tokenizeWords(newText);

  // Find common words (fast Set-based approach)
  const [oldLCS, newLCS] = computeWordLCS(oldTokens.words, newTokens.words);

  // Find character ranges that differ
  const oldRanges = findDiffRanges(oldTokens.words, oldTokens.positions, oldLCS);
  const newRanges = findDiffRanges(newTokens.words, newTokens.positions, newLCS);

  return { oldRanges, newRanges };
}

/**
 * Apply word-level highlights to syntax-highlighted HTML
 *
 * Takes Shiki's HTML output and wraps changed portions in <mark> tags
 * Preserves Shiki's <span> structure while adding our highlights
 *
 * @param htmlContent - Shiki's syntax-highlighted HTML
 * @param plainText - Original plain text (for position tracking)
 * @param ranges - Character ranges to highlight
 * @param type - 'addition' or 'deletion' (determines CSS class)
 */
export function applyWordHighlights(
  htmlContent: string,
  plainText: string,
  ranges: HighlightRange[],
  type: "addition" | "deletion"
): string {
  if (ranges.length === 0) {
    return htmlContent;
  }

  // CSS class for word-level highlights
  const markClass = type === "addition" ? "diff-word-addition" : "diff-word-deletion";

  // Parse HTML to track positions
  // Strategy: Walk through HTML and plain text simultaneously
  // When we hit a range, insert <mark> tags

  let result = "";
  let plainTextPos = 0;
  let htmlPos = 0;
  let currentRangeIndex = 0;
  let inTag = false;
  let markOpen = false;

  while (htmlPos < htmlContent.length) {
    const char = htmlContent[htmlPos];

    // Track when we're inside an HTML tag
    if (char === "<") {
      inTag = true;
    } else if (char === ">") {
      inTag = false;
      result += char;
      htmlPos++;
      continue;
    }

    // If inside tag, just copy
    if (inTag) {
      result += char;
      htmlPos++;
      continue;
    }

    // If it's an HTML entity, handle specially
    if (char === "&") {
      const entityMatch = htmlContent.slice(htmlPos).match(/^&[a-z]+;/i);
      if (entityMatch) {
        // Copy entity and advance plain text by 1
        result += entityMatch[0];
        htmlPos += entityMatch[0].length;
        plainTextPos++;
        continue;
      }
    }

    // Check if we should start a highlight
    if (
      currentRangeIndex < ranges.length &&
      plainTextPos === ranges[currentRangeIndex].start &&
      !markOpen
    ) {
      result += `<mark class="${markClass}">`;
      markOpen = true;
    }

    // Copy the character
    result += char;
    plainTextPos++;
    htmlPos++;

    // Check if we should end a highlight
    if (
      markOpen &&
      currentRangeIndex < ranges.length &&
      plainTextPos >= ranges[currentRangeIndex].end
    ) {
      result += "</mark>";
      markOpen = false;
      currentRangeIndex++;
    }
  }

  // Close any open mark tag
  if (markOpen) {
    result += "</mark>";
  }

  return result;
}
