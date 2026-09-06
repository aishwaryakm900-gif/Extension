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

  // Fix detached apostrophes in contractions and possessives without changing the quote character:
  // e.g. "Layla ’ s" -> "Layla’s", "don ' t" -> "don't"
  text = text.replace(/([a-zA-Z0-9]+)\s+(['’`´])\s*([a-zA-Z]+)/g, "$1$2$3");
  text = text.replace(/([a-zA-Z0-9]+)\s*(['’`´])\s+([a-zA-Z]+)/g, "$1$2$3");
  text = text.replace(/([a-zA-Z0-9]+s)\s+(['’`´])(?=\s|$|[.,;:!?])/g, "$1$2");

  // Fix spaces before punctuation: "screams ," -> "screams,"
  text = text.replace(/\s+([,.:;!?])/g, "$1");

  // Fix quotes spacing: "“ hello ”" -> "“hello”"
  text = text.replace(/([“‘(\[{])\s+/g, "$1").replace(/\s+([”’\)\]}])/g, "$1");

  return text.trim();
}

/**
 * Common technical and programming tokens that contain punctuation or symbols.
 */
export const COMMON_TECH_TOKENS = new Set([
  "c++", "c#", "f#", ".net", "asp.net", "node.js", "next.js", "vue.js", "react.js",
  "nuxt.js", "nest.js", "express.js", "three.js", "d3.js", "angular.js", "backbone.js",
  "rxjs", "graphql", "postgresql", "mysql", "nosql", "sqlite", "mongodb",
  "tensorflow", "pytorch", "opencv", "langchain", "langgraph", "scikit-learn",
  "rag", "llm", "nlp", "ocr", "api", "sdk", "cli", "gui", "ui", "ux", "css", "html"
]);

/**
 * Checks if a token matches common programming or technical naming patterns:
 * e.g., C++, C#, .NET, Node.js, Next.js, or word.js
 */
export function isTechnicalToken(word: string): boolean {
  if (!word) return false;
  const lower = word.toLowerCase().trim();
  if (COMMON_TECH_TOKENS.has(lower)) return true;
  if (/^c\+\+$/i.test(lower) || /^c#$/i.test(lower) || /^f#$/i.test(lower)) return true;
  if (/^\.?[a-z0-9_-]+(\.[a-z0-9_-]+)+$/i.test(lower)) return true;
  return false;
}

/**
 * Determines whether a given string represents a meaningful, searchable word or technical token.
 */
export function isMeaningfulWord(word: string): boolean {
  if (!word) return false;
  const trimmed = word.trim();
  if (!trimmed) return false;

  // Technical token check (e.g. C++, C#, .NET, Node.js)
  if (isTechnicalToken(trimmed)) return true;

  // Pure punctuation / symbols is not a word
  if (/^[^\w\s]+$/.test(trimmed)) return false;

  // Single letters other than 'a', 'A', 'I'
  if (/^[a-zA-Z]$/.test(trimmed)) {
    return trimmed === "a" || trimmed === "A" || trimmed === "I";
  }

  // Natural words with apostrophes or hyphens:
  // e.g. "night", "melancholy", "poignant", "JavaScript", "Python", "don't", "state-of-the-art"
  if (/^[a-zA-Z]+([’'-][a-zA-Z]+)*$/.test(trimmed)) {
    return true;
  }

  // Alphanumeric identifier (e.g. "OAuth2", "HTML5", "UTF8", "i18n", "Web3")
  if (/^[a-zA-Z0-9]+([’'-][a-zA-Z0-9]+)*$/.test(trimmed) && /[a-zA-Z]/.test(trimmed)) {
    return true;
  }

  return false;
}

/**
 * Tokenizes text preserving technical tokens (C++, C#, .NET, Node.js),
 * standard words, hyphenated words, and contractions.
 */
export function extractTokensFromText(text: string): string[] {
  if (!text) return [];
  const matches = text.match(/(?:\bC\+\+|\bC#|\.NET\b|\b[a-zA-Z0-9_-]+\.js\b|\b[a-zA-Z0-9]+(?:['’][a-zA-Z0-9]+)?(?:-[a-zA-Z0-9]+)*\b)/gi);
  return matches ? Array.from(matches) : [];
}

export function cleanSelection(value: string): string {
  if (!value) return "";
  let text = healExtractedText(value);

  // If the whole selection is a recognized technical token (e.g. "C++", "C#", ".NET"), do not strip symbols!
  if (isTechnicalToken(text)) {
    return text;
  }

  // 1. Clean leading sentence boundary bleed from adjacent spans/previous line:
  // e.g. "s. Now that he knew..." -> "Now that he knew..."
  // e.g. "d. The committee..." -> "The committee..."
  // e.g. ". Now that he knew..." -> "Now that he knew..."
  text = text.replace(/^[a-zA-Z0-9]{1,2}[.!?]\s+(?=[A-Z0-9])/g, "");
  text = text.replace(/^[.!?]\s+(?=[A-Z0-9])/g, "");

  // 2. Clean leading symbol/punctuation bleed preceding an alphanumeric token:
  // e.g. "++, JavaS" -> "JavaS"
  // e.g. ", Python" -> "Python"
  // e.g. "::vector" -> "vector"
  // e.g. "->property" -> "property"
  if (!isTechnicalToken(text)) {
    text = text.replace(/^[+*\/=<>~`|^&%$@!?:;,\s]+(?=[a-zA-Z0-9])/g, "");
  }

  // 3. Clean leading 1-letter boundary bleed for single words / short phrases:
  // e.g. "t night" -> "night" (unless the word is "a" or "I")
  text = text.replace(/^([b-hj-zB-HJ-Z])\s+([a-zA-Z]{2,}.*)$/g, "$2");

  // 4. Clean trailing bleed after sentence terminators:
  // e.g. "lifestyle. S" -> "lifestyle."
  text = text.replace(/([.!?])\s+[a-zA-Z0-9]{1,2}$/g, "$1");

  // 5. Clean trailing stray comma/semicolon/colon/pipe/slash bleed:
  // e.g. "Python, " -> "Python"
  if (!isTechnicalToken(text)) {
    text = text.replace(/\s*[,;:|\/]+$/g, "");
  }

  return text.trim();
}

export function normalizeSelection(value: string): string {
  return cleanSelection(value);
}

export function classifySelection(selectedText: string): SelectionType {
  const normalized = normalizeSelection(selectedText);
  if (!normalized) return "unknown";

  const words = normalized.split(/\s+/).filter(Boolean);
  const sentenceCount = (normalized.match(/[.!?](?:\s|$)/g) ?? []).length;
  
  if (sentenceCount > 1 || words.length > 40) return "passage";
  if (sentenceCount === 1 || (words.length >= 6 && /^[A-Z]/.test(normalized)) || (words.length >= 8) || /[.!?]$/.test(normalized)) {
    return "sentence";
  }
  if (words.length > 1) return "phrase";
  if (/^[a-zA-Z0-9'’-]+$/.test(normalized)) return "word";
  return "word";
}

export const detectSelectionType = classifySelection;
export const findContainingSentence = extractSentence;

/**
 * Intelligent Selection Resolution Pipeline.
 * Resolves candidate words for partial selections using:
 * 1. Technical token validation (e.g. C++, C#, .NET, Node.js)
 * 2. Boundary bleed cleaning (e.g. "++, JavaS" -> "JavaS" -> "JavaScript")
 * 3. Immediate DOM boundaries (prefixAttached/suffixAttached)
 * 4. Local surrounding line inspection (finding full tokens containing the fragment)
 * 5. Strict guard against overcorrecting valid/complete words.
 */
export function resolveSelectionCandidate(
  selectedText: string,
  prefixAttached: string = "",
  suffixAttached: string = "",
  surroundingText: string = ""
): SelectionAnalysis & { confidence: "high" | "medium" | "low" } {
  const original = (selectedText ?? "").trim();
  if (!original) {
    return {
      originalSelection: "",
      resolvedSelection: "",
      selectionType: "unknown",
      isPartial: false,
      confidence: "low"
    };
  }

  // 1. Direct Technical Token Check (e.g. "C++", "C#", ".NET", "Node.js")
  if (isTechnicalToken(original)) {
    return {
      originalSelection: original,
      resolvedSelection: original,
      selectionType: "word",
      isPartial: false,
      confidence: "high"
    };
  }

  // 2. Pure punctuation / symbol handling (e.g. selecting "++" next to "C")
  if (/^[^\w\s]+$/.test(original)) {
    // Check if prefixAttached forms a technical token (e.g. "C" + "++" -> "C++")
    const cleanPrefix = prefixAttached.replace(/^.*[\s.,;:!?()[\]{}'’"]/, "");
    if (cleanPrefix && isTechnicalToken(`${cleanPrefix}${original}`)) {
      return {
        originalSelection: original,
        resolvedSelection: `${cleanPrefix}${original}`,
        selectionType: "word",
        isPartial: true,
        confidence: "high"
      };
    }
    // Check if surrounding text has a technical token containing this symbol
    if (surroundingText) {
      const tokens = extractTokensFromText(surroundingText);
      const techMatch = tokens.find((t) => isTechnicalToken(t) && t.includes(original));
      if (techMatch) {
        return {
          originalSelection: original,
          resolvedSelection: techMatch,
          selectionType: "word",
          isPartial: true,
          confidence: "high"
        };
      }
    }
    // Pure punctuation without technical token context is not a meaningful word
    return {
      originalSelection: original,
      resolvedSelection: original,
      selectionType: "unknown",
      isPartial: false,
      confidence: "low"
    };
  }

  // 3. Clean leading/trailing boundary bleed and punctuation
  // e.g. "++, JavaS" -> "JavaS"
  // e.g. ", Python" -> "Python"
  // e.g. "s. Now that he knew..." -> "Now that he knew..."
  const cleaned = cleanSelection(original);

  // 4. Complete Sentence / Passage Check
  const sentenceCount = (cleaned.match(/[.!?](?:\s|$)/g) ?? []).length;
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (sentenceCount > 1 || words.length > 40) {
    return {
      originalSelection: original,
      resolvedSelection: cleaned,
      selectionType: "passage",
      isPartial: false,
      confidence: "high"
    };
  }
  if (sentenceCount === 1 || (words.length >= 6 && /^[A-Z]/.test(cleaned)) || words.length >= 8 || /[.!?]$/.test(cleaned)) {
    return {
      originalSelection: original,
      resolvedSelection: cleaned,
      selectionType: "sentence",
      isPartial: false,
      confidence: "high"
    };
  }

  // 5. Valid Multi-Word Phrase Check
  // Only treated as a phrase if it doesn't start with random punctuation bleed (like "++, ")
  if (words.length > 1 && !/^[+*\/=<>~`|^&%$@!?:;,\s]+/.test(original)) {
    const allWordsValid = words.every((w) => isMeaningfulWord(w));
    if (allWordsValid) {
      return {
        originalSelection: original,
        resolvedSelection: cleaned,
        selectionType: "phrase",
        isPartial: false,
        confidence: "high"
      };
    }
  }

  // 6. Word / Fragment Target Determination:
  // If cleaned is a single word or extracted from corrupted selection (e.g. "++, JavaS" -> "JavaS")
  const targetFragment = words.length === 1 ? words[0] : cleaned;

  // Check DOM boundaries for attached prefix/suffix (e.g. "ello" with prefix "h" -> "hello")
  const cleanPrefix = prefixAttached.replace(/^.*[\s.,;:!?()[\]{}'’"]/, "");
  const cleanSuffix = suffixAttached.replace(/[\s.,;:!?()[\]{}'’"].*$/, "");
  const hasPrefix = cleanPrefix.length > 0 && /^[a-zA-Z0-9'’+#.-]+$/.test(cleanPrefix);
  const hasSuffix = cleanSuffix.length > 0 && /^[a-zA-Z0-9'’+#.-]+$/.test(cleanSuffix);

  if ((hasPrefix || hasSuffix) && /^[a-zA-Z0-9'’+#.-]+$/.test(targetFragment)) {
    const fullWord = cleanSelection(`${cleanPrefix}${targetFragment}${cleanSuffix}`);
    if (fullWord.toLowerCase() !== targetFragment.toLowerCase() && fullWord.length > targetFragment.length) {
      return {
        originalSelection: original,
        resolvedSelection: fullWord,
        selectionType: "partial-word",
        isPartial: true,
        confidence: "high"
      };
    }
  }

  // Check immediate surrounding line/context for complete token matching targetFragment
  // (e.g. "JavaS" -> "JavaScript", "congratulat" -> "congratulations", "mela" -> "melancholy")
  if (surroundingText && targetFragment.length >= 2) {
    const tokens = extractTokensFromText(surroundingText);
    const lowerTarget = targetFragment.toLowerCase();

    // Look for exact token first (if already a full valid token like "Python", "melancholy", "C++")
    const exactMatch = tokens.find((t) => t.toLowerCase() === lowerTarget);
    if (exactMatch && isMeaningfulWord(exactMatch) && !/^[+*\/=<>~`|^&%$@!?:;,\s]+/.test(original)) {
      return {
        originalSelection: original,
        resolvedSelection: exactMatch,
        selectionType: "word",
        isPartial: false,
        confidence: "high"
      };
    }

    // Look for token that starts with, ends with, or extends targetFragment
    const candidate = tokens.find((t) => {
      const lowerT = t.toLowerCase();
      return lowerT !== lowerTarget && (
        lowerT.startsWith(lowerTarget) ||
        lowerT.endsWith(lowerTarget) ||
        (lowerTarget.length >= 4 && lowerT.includes(lowerTarget))
      );
    });

    if (candidate && candidate.length > targetFragment.length) {
      return {
        originalSelection: original,
        resolvedSelection: candidate,
        selectionType: "partial-word",
        isPartial: true,
        confidence: "high"
      };
    }
  }

  // If already a valid complete word (e.g. "Python", "melancholy", "poignant", "night", "C++")
  if (isMeaningfulWord(cleaned)) {
    return {
      originalSelection: original,
      resolvedSelection: cleaned,
      selectionType: "word",
      isPartial: false,
      confidence: "high"
    };
  }

  // Fallback: Return cleaned selection
  return {
    originalSelection: original,
    resolvedSelection: cleaned,
    selectionType: classifySelection(cleaned),
    isPartial: false,
    confidence: "medium"
  };
}

export const analyzeSelectionBoundaries = resolveSelectionCandidate;

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
  const previousStop = before.search(/[.!?](?:\s+|$)[^.!?]*$/);
  let sentenceStart = 0;

  if (previousStop >= 0) {
    const afterPunctuation = before.slice(previousStop + 1);
    const leadingWhitespace = afterPunctuation.match(/^\s+/);
    sentenceStart = previousStop + 1 + (leadingWhitespace ? leadingWhitespace[0].length : 0);
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
  const originalSelection = cleanSelection(rawSelection).slice(0, MAX_SELECTION_LENGTH);
  const resolvedSelection = input.resolvedSelection ? cleanSelection(input.resolvedSelection) : originalSelection;
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
