export type SelectionType = "word" | "partial-word" | "phrase" | "sentence" | "passage" | "unknown";
export type SourceType = "webpage" | "pdf";

export type ReadingContext = {
  originalSelection?: string;
  resolvedSelection?: string;
  selectedText: string;
  selectionType: SelectionType;
  sentence: string;
  paragraph: string;
  surroundingContext: string;
  context: string;
  pageTitle?: string;
  sourceUrl?: string;
  sourceType: SourceType;
  pageNumber?: number;
};

export type SelectionAnalysis = {
  originalSelection: string;
  resolvedSelection: string;
  selectionType: SelectionType;
  isPartial: boolean;
};

const MAX_SELECTION_LENGTH = 2000;
const MAX_SENTENCE_LENGTH = 500;
const MAX_CONTEXT_LENGTH = 1500;

/**
 * Normalizes excessive whitespace and fixes common split-word/ligature/punctuation artifacts
 * introduced by nested DOM spans, PDF line fragments, or typographic ligature wrappers.
 */
export function healExtractedText(value: string): string {
  if (!value) return "";

  let text = value
    // Normalize unicode spaces and soft hyphens
    .replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000]/g, " ")
    .replace(/\u00AD/g, "")
    // Collapse newlines/tabs/whitespace
    .replace(/\s+/g, " ");

  // Fix words split across ligatures (e.g. "mu fll ed" -> "muffled", "mu fl ed" -> "muffled")
  text = text.replace(/\b([a-zA-Z]+)\s+(fll?|ffi?|ff)\s+([a-zA-Z]+)\b/gi, (_match, p1, p2, p3) => {
    const ligature = p2.toLowerCase() === "fll" ? "ffl" : p2;
    return `${p1}${ligature}${p3}`;
  });

  // Fix common split prefixes (e.g. "inter view" -> "interview")
  text = text.replace(/\b(inter)\s+(view|views|viewed|viewing)\b/gi, "$1$2");

  // Fix detached apostrophes in contractions and possessives:
  // e.g. "Layla ’ s" -> "Layla’s", "don ' t" -> "don't", "can ’ t" -> "can’t", "I ’ m" -> "I’m"
  text = text.replace(/([a-zA-Z0-9]+)\s*['’`´]\s*([a-zA-Z]+)/g, "$1’$2");

  // Fix plural possessives: "readers ’ " -> "readers’ "
  text = text.replace(/([a-zA-Z0-9]+s)\s*['’`´](?=\s|$|[.,;:!?])/g, "$1’");

  // Fix spaces before punctuation: "screams ," -> "screams,"
  text = text.replace(/\s+([,.:;!?])/g, "$1");

  // Fix quotes spacing: "“ hello ”" -> "“hello”"
  text = text.replace(/([“‘(\[{])\s+/g, "$1").replace(/\s+([”’\)\]}])/g, "$1");

  return text.trim();
}

export function normalizeSelection(value: string): string {
  return healExtractedText(value);
}

export function classifySelection(selectedText: string): SelectionType {
  const normalized = normalizeSelection(selectedText);
  if (!normalized) return "unknown";

  const sentenceCount = (normalized.match(/[.!?](?:\s|$)/g) ?? []).length;
  if (sentenceCount > 1) return "passage";
  // Complete sentence check: ends with sentence punctuation or is a capitalized complete thought > 30 chars
  if (sentenceCount === 1 && (normalized.length > 30 || /[.!?]$/.test(normalized))) return "sentence";
  if (/\s/.test(normalized)) return "phrase";
  if (/^[a-zA-Z0-9'’-]+$/.test(normalized)) return "word";
  return "word";
}

export const detectSelectionType = classifySelection;
export const findContainingSentence = extractSentence;

/**
 * Deterministically analyzes a selection to detect if the user selected a partial word.
 * For instance, selecting "ello" or "hell" from "hello" in the text.
 */
export function analyzeSelectionBoundaries(
  selectedText: string,
  prefixAttached: string = "",
  suffixAttached: string = ""
): SelectionAnalysis {
  const original = selectedText.trim();
  const cleanPrefix = prefixAttached.replace(/^.*[\s.,;:!?()[\]{}'’"]/, "");
  const cleanSuffix = suffixAttached.replace(/[\s.,;:!?()[\]{}'’"].*$/, "");

  const hasPrefix = cleanPrefix.length > 0 && /^[a-zA-Z0-9'’-]+$/.test(cleanPrefix);
  const hasSuffix = cleanSuffix.length > 0 && /^[a-zA-Z0-9'’-]+$/.test(cleanSuffix);

  // Check if this is a partial-word selection
  if ((hasPrefix || hasSuffix) && !/\s/.test(original) && /^[a-zA-Z0-9'’-]+$/.test(original)) {
    const fullWord = healExtractedText(`${cleanPrefix}${original}${cleanSuffix}`);
    if (fullWord.toLowerCase() !== original.toLowerCase() && fullWord.length > original.length) {
      return {
        originalSelection: original,
        resolvedSelection: fullWord,
        selectionType: "partial-word",
        isPartial: true
      };
    }
  }

  const selectionType = classifySelection(original);
  return {
    originalSelection: original,
    resolvedSelection: original,
    selectionType,
    isPartial: false
  };
}

/**
 * Extracts ONLY the sentence containing the selected text.
 * Never includes text from previous pages or everything before the word.
 * If sentence punctuation is not found, bounds backward search to the local line/clause.
 */
export function extractSentence(text: string, selectedText: string): string {
  const normalized = healExtractedText(text);
  const selected = healExtractedText(selectedText);
  if (!normalized || !selected) return selected;

  const selectedIndex = normalized.toLocaleLowerCase().indexOf(selected.toLocaleLowerCase());
  if (selectedIndex < 0) {
    // If not found in text, bound return length to a single sentence window
    return normalized.slice(0, Math.min(250, normalized.length));
  }

  const before = normalized.slice(0, selectedIndex);
  const after = normalized.slice(selectedIndex + selected.length);

  // Search backwards for a sentence terminator (. ! ?)
  const previousStop = before.search(/[.!?](?:\s|$)[^.!?]*$/);
  let sentenceStart = 0;

  if (previousStop >= 0) {
    sentenceStart = previousStop + 2;
  } else {
    // No previous sentence terminator found.
    // DO NOT take everything from index 0 of a giant document/page!
    const lastLineBreak = before.lastIndexOf("\n");
    if (lastLineBreak >= 0 && before.length - lastLineBreak < 200) {
      sentenceStart = lastLineBreak + 1;
    } else if (before.length > 180) {
      // Find a clean word boundary roughly 140-180 chars before the selection
      const windowStart = Math.max(0, before.length - 160);
      const windowText = before.slice(windowStart);
      const spaceIdx = windowText.indexOf(" ");
      sentenceStart = spaceIdx >= 0 ? windowStart + spaceIdx + 1 : windowStart;
    } else {
      sentenceStart = 0;
    }
  }

  // Search forwards for next sentence terminator
  const nextStop = after.search(/[.!?](?:\s|$)/);
  let sentenceEnd = normalized.length;

  if (nextStop >= 0) {
    sentenceEnd = selectedIndex + selected.length + nextStop + 1;
  } else {
    const nextLineBreak = after.indexOf("\n");
    if (nextLineBreak >= 0 && nextLineBreak < 200) {
      sentenceEnd = selectedIndex + selected.length + nextLineBreak;
    } else if (after.length > 180) {
      const windowEnd = Math.min(after.length, 160);
      const windowText = after.slice(0, windowEnd);
      const lastSpace = windowText.lastIndexOf(" ");
      sentenceEnd = selectedIndex + selected.length + (lastSpace >= 0 ? lastSpace : windowEnd);
    } else {
      sentenceEnd = selectedIndex + selected.length + after.length;
    }
  }

  const extracted = normalized.slice(sentenceStart, sentenceEnd).trim();
  return extracted.slice(0, MAX_SENTENCE_LENGTH);
}

/**
 * Builds a SELECTION-AWARE minimal context.
 *
 * Core rule:
 * - WORD: selected word is primary target. Context is ONLY the sentence containing the word.
 * - PHRASE: selected phrase is primary target. Context is ONLY the sentence containing the phrase.
 * - SENTENCE: selected sentence itself is the primary target and primary context.
 * - PASSAGE: selected passage itself is the primary target and primary context.
 *
 * NEVER dumps the entire PDF or page before the selected word.
 */
export function buildReadingContext(input: {
  selectedText: string;
  originalSelection?: string;
  resolvedSelection?: string;
  selectionType?: SelectionType;
  text?: string;
  paragraph?: string;
  nearbyText?: string;
  pageTitle?: string;
  sourceUrl?: string;
  sourceType: SourceType;
  pageNumber?: number;
}): ReadingContext {
  const rawSelection = input.selectedText || input.originalSelection || "";
  const originalSelection = healExtractedText(rawSelection).slice(0, MAX_SELECTION_LENGTH);
  const resolvedSelection = input.resolvedSelection ? healExtractedText(input.resolvedSelection) : originalSelection;
  const selectionType = input.selectionType ?? classifySelection(resolvedSelection || originalSelection);

  // Local text to extract sentence from (prefer immediate paragraph/line over entire page)
  const localSource = input.paragraph || input.text || resolvedSelection;
  const sentence = extractSentence(localSource, resolvedSelection || originalSelection);

  let minimalContext = "";
  let paragraph = "";
  let surroundingContext = "";

  if (selectionType === "word" || selectionType === "partial-word") {
    // For a single word, the ONLY context is the sentence containing the word.
    // Do NOT send the entire page or document!
    minimalContext = sentence;
    paragraph = sentence;
    surroundingContext = sentence;
  } else if (selectionType === "phrase") {
    // For a phrase, context is the containing sentence.
    minimalContext = sentence;
    paragraph = sentence;
    surroundingContext = sentence;
  } else if (selectionType === "sentence") {
    // For a complete sentence, the selected sentence itself is the primary context.
    minimalContext = resolvedSelection;
    paragraph = sentence || resolvedSelection;
    surroundingContext = sentence || resolvedSelection;
  } else {
    // For a passage / multiple sentences, the selected passage is the primary context.
    minimalContext = resolvedSelection;
    paragraph = healExtractedText(input.paragraph || resolvedSelection).slice(0, MAX_CONTEXT_LENGTH);
    surroundingContext = paragraph;
  }

  return {
    selectedText: resolvedSelection,
    originalSelection,
    resolvedSelection,
    selectionType,
    sentence,
    paragraph,
    surroundingContext,
    context: minimalContext,
    ...(input.pageTitle ? { pageTitle: input.pageTitle.trim().slice(0, 500) } : {}),
    ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
    sourceType: input.sourceType,
    ...(input.pageNumber === undefined ? {} : { pageNumber: input.pageNumber })
  };
}
