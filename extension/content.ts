import {
  resolvePronunciation,
  isCamelCase,
  splitCamelCase,
  isEligibleForPronunciation,
  normalizeSpokenText,
  isValidIpa
} from "./pronunciation";

const HOST_ID = "reader-ai-selection-host";
const POPUP_WIDTH = 320;
const VIEWPORT_MARGIN = 16;
const SELECTION_GAP = 8;
const MAX_POPUP_HEIGHT = 650;

let popupHost: HTMLDivElement | null = null;
let popupRoot: ShadowRoot | null = null;
let activePopupElement: HTMLElement | null = null;
let activeRange: Range | null = null;
let interactingWithPopup = false;
let currentTheme: "light" | "dark" = "light";

try {
  const saved = localStorage.getItem("reader_theme");
  if (saved === "light" || saved === "dark") {
    currentTheme = saved;
  }
} catch { }

if (typeof chrome !== "undefined" && chrome.storage?.local) {
  chrome.storage.local.get("reader_theme", (res) => {
    if (res?.reader_theme === "light" || res?.reader_theme === "dark") {
      currentTheme = res.reader_theme;
      if (activePopupElement) {
        activePopupElement.setAttribute("data-theme", currentTheme);
      }
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.reader_theme) {
      const next = changes.reader_theme.newValue;
      if (next === "light" || next === "dark") {
        currentTheme = next;
        if (activePopupElement) {
          activePopupElement.setAttribute("data-theme", currentTheme);
        }
      }
    }
  });
}

type SelectionData = {
  originalSelection: string;
  resolvedSelection: string;
  selectedText: string;
  selectionType: "word" | "partial-word" | "phrase" | "sentence" | "passage" | "unknown";
  sentence: string;
  paragraph: string;
  surroundingContext: string;
  pageTitle: string;
  sourceUrl: string;
  sourceType: "webpage" | "pdf";
  rect: DOMRect;
};

type Explanation = {
  type: "word" | "phrase" | "explanation";
  word?: string;
  partOfSpeech?: string;
  pronunciation?: string;
  meaning?: string;
  simpleMeaning?: string;
  contextExplanation?: string;
  example?: string;
  phrase?: string;
  simpleExplanation?: string;
  selectedText?: string;
  keyPoints?: string[];
};

type ExplainResponse =
  | { ok: true; result: Explanation }
  | { ok: false; error: string };

function healText(value: string): string {
  if (!value) return "";

  let text = value
    .replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000]/g, " ")
    .replace(/\u00AD/g, "")
    .replace(/\s+/g, " ");

  // Heal words split across ligatures (e.g. "mu fll ed" -> "muffled")
  text = text.replace(/\b([a-zA-Z]+)\s+(fll?|ffi?|ff)\s+([a-zA-Z]+)\b/gi, (_m, p1, p2, p3) => {
    const ligature = p2.toLowerCase() === "fll" ? "ffl" : p2;
    return `${p1}${ligature}${p3}`;
  });

  // Heal common prefix splits (e.g. "inter view" -> "interview")
  text = text.replace(/\b(inter)\s+(view|views|viewed|viewing)\b/gi, "$1$2");

  // Reconnect detached apostrophes without changing quote character (e.g. "don ' t" -> "don't")
  text = text.replace(/([a-zA-Z0-9]+)\s+(['’`´])\s*([a-zA-Z]+)/g, "$1$2$3");
  text = text.replace(/([a-zA-Z0-9]+)\s*(['’`´])\s+([a-zA-Z]+)/g, "$1$2$3");
  text = text.replace(/([a-zA-Z0-9]+s)\s+(['’`´])(?=\s|$|[.,;:!?])/g, "$1$2");

  // Fix spaces before punctuation
  text = text.replace(/\s+([,.:;!?])/g, "$1");

  // Quotes spacing
  text = text.replace(/([“‘(\[{])\s+/g, "$1").replace(/\s+([”’\)\]}])/g, "$1");

  return text.trim();
}

function isIgnoredNode(node: Node, selectionContainer?: Node | null): boolean {
  if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node as Element;
    if (el.id === HOST_ID || el.classList.contains("reader-ai-popup")) return true;
    const tag = el.tagName.toLowerCase();

    // Ignore interactive, script, or non-text elements
    if (["script", "style", "noscript", "template", "svg", "button", "input", "select", "textarea", "video", "audio", "canvas"].includes(tag)) {
      return true;
    }

    // Ignore site chrome (nav, footer, aside, ads) unless selection is explicitly inside it
    if (["nav", "footer", "header", "aside", "menu"].includes(tag)) {
      if (selectionContainer && el.contains(selectionContainer)) {
        return false;
      }
      return true;
    }

    // Check aria roles for navigation or banner chrome
    const role = el.getAttribute("role");
    if (role && ["navigation", "banner", "contentinfo", "complementary"].includes(role)) {
      if (selectionContainer && el.contains(selectionContainer)) {
        return false;
      }
      return true;
    }

    if (el.getAttribute("aria-hidden") === "true") return true;
  }
  return false;
}

function getClosestTextContainer(range: Range): HTMLElement {
  let node: Node | null = range.commonAncestorContainer;
  if (node.nodeType === Node.TEXT_NODE) {
    node = node.parentElement;
  }
  const el = node as HTMLElement | null;
  if (!el) return document.body;

  // 1. First look for the standard paragraph / text block elements
  const blockMatch = el.closest<HTMLElement>("p, li, blockquote, dd, dt, h1, h2, h3, h4, h5, h6, figcaption, td, th, summary");
  if (blockMatch && !blockMatch.closest(`#${HOST_ID}`)) {
    return blockMatch;
  }

  // 2. Otherwise traverse upward to find the nearest block-level or flex-level element
  let curr: HTMLElement | null = el;
  while (curr && curr !== document.body && curr !== document.documentElement) {
    if (curr.id === HOST_ID) break;
    const display = window.getComputedStyle(curr).display;
    if (display === "block" || display === "flex" || display === "grid" || display === "list-item") {
      return curr;
    }
    curr = curr.parentElement;
  }
  return el;
}

function extractCleanTextFromContainer(container: HTMLElement, selectionContainer?: Node | null): string {
  let result = "";
  let lastEndedWithSpace = true;

  function walk(node: Node) {
    if (isIgnoredNode(node, selectionContainer)) return;

    if (node.nodeType === Node.TEXT_NODE) {
      const content = node.textContent || "";
      if (!content) return;

      const hasLeadingSpace = /^\s/.test(content);
      const hasTrailingSpace = /\s$/.test(content);
      const clean = content.replace(/\s+/g, " ");

      if (clean === " ") {
        if (!lastEndedWithSpace && result.length > 0) {
          result += " ";
          lastEndedWithSpace = true;
        }
        return;
      }

      const trimmed = clean.trim();
      if (!trimmed) return;

      if (hasLeadingSpace && !lastEndedWithSpace && result.length > 0) {
        if (!/^['’`´,.:;!?]/.test(trimmed)) {
          result += " ";
          lastEndedWithSpace = true;
        }
      }

      result += trimmed;
      lastEndedWithSpace = hasTrailingSpace;
      if (hasTrailingSpace) {
        result += " ";
        lastEndedWithSpace = true;
      }
      return;
    }

    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      const tag = el.tagName.toLowerCase();
      const isBlock = ["p", "div", "li", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "section", "article"].includes(tag);

      if (isBlock && !lastEndedWithSpace && result.length > 0) {
        result += " ";
        lastEndedWithSpace = true;
      }

      for (const child of Array.from(node.childNodes)) {
        walk(child);
      }

      if (isBlock && !lastEndedWithSpace && result.length > 0) {
        result += " ";
        lastEndedWithSpace = true;
      }
    }
  }

  walk(container);
  return healText(result);
}

function extractSentenceFromText(text: string, selectedText: string): string {
  const normalized = healText(text);
  const selected = healText(selectedText);
  if (!normalized || !selected) return selected;

  const selectedIndex = normalized.toLocaleLowerCase().indexOf(selected.toLocaleLowerCase());
  if (selectedIndex < 0) return normalized.slice(0, 500);

  const before = normalized.slice(0, selectedIndex);
  const after = normalized.slice(selectedIndex + selected.length);

  // Look backwards for sentence stop (. ! ? or newline)
  const previousStop = before.search(/([.!?](?:\s+|$)|[\r\n]+)[^.!?\r\n]*$/);
  let sentenceStart = 0;
  if (previousStop >= 0) {
    const match = before.slice(previousStop).match(/^([.!?]\s+|[\r\n]+)/);
    sentenceStart = previousStop + (match ? match[0].length : 1);
  } else {
    // If no punctuation found backwards, bound to at most 160 characters before the selection
    sentenceStart = Math.max(0, selectedIndex - 160);
    const spaceIdx = normalized.indexOf(" ", sentenceStart);
    if (spaceIdx >= 0 && spaceIdx < selectedIndex) {
      sentenceStart = spaceIdx + 1;
    }
  }

  // Look forwards for sentence stop (. ! ? or newline)
  const nextStop = after.search(/[.!?](?:\s+|$)|[\r\n]+/);
  let sentenceEnd = normalized.length;
  if (nextStop >= 0) {
    sentenceEnd = selectedIndex + selected.length + nextStop + 1;
  } else {
    // If no punctuation found forwards, bound to at most 160 characters after the selection
    sentenceEnd = Math.min(normalized.length, selectedIndex + selected.length + 160);
    const spaceIdx = normalized.lastIndexOf(" ", sentenceEnd);
    if (spaceIdx > selectedIndex + selected.length) {
      sentenceEnd = spaceIdx;
    }
  }

  const result = normalized.slice(sentenceStart, sentenceEnd).trim();
  return result;
}

const COMMON_TECH_TOKENS = new Set([
  "c++", "c#", "f#", ".net", "asp.net", "node.js", "next.js", "vue.js", "react.js",
  "nuxt.js", "nest.js", "express.js", "three.js", "d3.js", "angular.js", "backbone.js",
  "rxjs", "graphql", "postgresql", "mysql", "nosql", "sqlite", "mongodb",
  "tensorflow", "pytorch", "opencv", "langchain", "langgraph", "scikit-learn",
  "rag", "llm", "nlp", "ocr", "api", "sdk", "cli", "gui", "ui", "ux", "css", "html",
  "sql", "json", "yaml", "xml", "jwt", "oauth", "rest", "grpc", "wasm", "docker",
  "k8s", "kubernetes", "git", "github", "ci", "cd", "cpu", "gpu", "ram", "rom",
  "dns", "http", "https", "ssh", "ssl", "tls", "tcp", "udp", "ip", "url", "uri", "dom", "crud"
]);

function isTechnicalToken(word: string): boolean {
  if (!word) return false;
  const lower = word.toLowerCase().trim();
  if (COMMON_TECH_TOKENS.has(lower)) return true;
  if (/^c\+\+$/i.test(lower) || /^c#$/i.test(lower) || /^f#$/i.test(lower)) return true;
  if (/^\.?[a-z0-9_-]+(\.[a-z0-9_-]+)+$/i.test(lower)) return true;
  return false;
}

function isPhonotacticallyPlausible(word: string): boolean {
  if (!word) return false;
  const lower = word.toLowerCase().trim();
  if (isTechnicalToken(lower)) return true;

  // Single letters: only 'a', 'i'
  if (lower.length === 1) return lower === "a" || lower === "i";

  // Must have at least one vowel (a, e, i, o, u, y)
  if (!/[aeiouy]/.test(lower)) return false;

  // Implausible English clusters
  if (/zq|qj|qk|qx|qz|jx|xj|vf|vj|vk|vx|vz|zf|zj|zk|zx/.test(lower)) return false;
  if (/q(?!u)/.test(lower) && lower !== "faq" && lower !== "sql") return false;
  if (/^[^aeiouy]{4,}/.test(lower) && !/^(?:str|spl|scr|spr|schw|phth)/.test(lower)) return false;
  if (/[^aeiouy]{5,}/.test(lower) && !/(?:lengths|strengths|angst)/.test(lower)) return false;

  return true;
}

function isMeaningfulWord(word: string): boolean {
  if (!word) return false;
  const trimmed = word.trim();
  if (!trimmed) return false;
  if (isTechnicalToken(trimmed)) return true;
  if (/^[^\w\s]+$/.test(trimmed)) return false;
  if (/^[a-zA-Z]$/.test(trimmed)) return trimmed === "a" || trimmed === "A" || trimmed === "I";
  if (!isPhonotacticallyPlausible(trimmed)) return false;
  if (/^[a-zA-Z]+([’'-][a-zA-Z]+)*$/.test(trimmed)) return true;
  if (/^[a-zA-Z0-9]+([’'-][a-zA-Z0-9]+)*$/.test(trimmed) && /[a-zA-Z]/.test(trimmed)) return true;
  return false;
}

function extractTokensFromText(text: string): string[] {
  if (!text) return [];
  const matches = text.match(/(?:\bC\+\+|\bC#|\.NET\b|\b[a-zA-Z0-9_-]+\.js\b|\b[a-zA-Z0-9]+(?:['’][a-zA-Z0-9]+)?(?:-[a-zA-Z0-9]+)*\b)/gi);
  return matches ? Array.from(matches) : [];
}

function cleanSelection(value: string): string {
  if (!value) return "";
  let text = healText(value);

  if (isTechnicalToken(text)) return text;

  // 1. Clean leading sentence boundary bleed from adjacent spans/previous line:
  text = text.replace(/^[a-zA-Z0-9]{1,2}[.!?]\s+(?=[A-Z0-9])/g, "");
  text = text.replace(/^[.!?]\s+(?=[A-Z0-9])/g, "");

  // 2. Clean leading symbol/punctuation bleed preceding an alphanumeric token:
  // e.g. "++, JavaS" -> "JavaS"
  if (!isTechnicalToken(text)) {
    text = text.replace(/^[+*\/=<>~`|^&%$@!?:;,\s]+(?=[a-zA-Z0-9])/g, "");
  }

  // 3. Clean leading 1-letter boundary bleed for single words / short phrases:
  text = text.replace(/^([b-hj-zB-HJ-Z])\s+([a-zA-Z]{2,}.*)$/g, "$2");

  // 4. Clean trailing bleed after sentence terminators:
  text = text.replace(/([.!?])\s+[a-zA-Z0-9]{1,2}$/g, "$1");

  // 5. Clean trailing stray punctuation:
  if (!isTechnicalToken(text)) {
    text = text.replace(/\s*[,;:|\/]+$/g, "");
  }

  return text.trim();
}

function isReaderAiNativePage(): boolean {
  if (typeof document === "undefined") return false;
  try {
    if ((window as unknown as { __READER_AI_NATIVE__?: boolean }).__READER_AI_NATIVE__ === true) {
      return true;
    }
    if (document.documentElement.getAttribute("data-reader-ai") === "true") {
      return true;
    }
    if (document.querySelector(".pdf-reader-shell") || document.querySelector(".reader-ai-popup")) {
      return true;
    }
    const path = (window.location.pathname || "").toLowerCase();
    if (path.startsWith("/reader") || path.includes("/reader/pdf")) {
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

function extractDomSelectionDetails(range: Range, rootContainer?: HTMLElement | null): {
  rawSelection: string;
  prefixAttached: string;
  suffixAttached: string;
  surroundingLine: string;
} {
  const rawSelection = range.toString();
  let prefixAttached = "";
  let suffixAttached = "";
  let surroundingLine = "";

  try {
    if (range.startContainer.nodeType === Node.TEXT_NODE) {
      const textBefore = (range.startContainer.textContent || "").slice(0, range.startOffset);
      const match = textBefore.match(/[a-zA-Z0-9'’+#.-]+$/);
      if (match) prefixAttached = match[0];
    }

    if (!prefixAttached) {
      let node: Node | null = range.startContainer;
      let prevText = "";
      while (node && !prevText) {
        if (node.previousSibling) {
          node = node.previousSibling;
          prevText = node.textContent || "";
        } else {
          node = node.parentNode;
          if (node === rootContainer || (node && node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).id === HOST_ID)) {
            break;
          }
        }
      }
      if (prevText) {
        const match = prevText.match(/[a-zA-Z0-9'’+#.-]+$/);
        if (match) prefixAttached = match[0];
      }
    }

    if (range.endContainer.nodeType === Node.TEXT_NODE) {
      const textAfter = (range.endContainer.textContent || "").slice(range.endOffset);
      const match = textAfter.match(/^[a-zA-Z0-9'’+#.-]+/);
      if (match) suffixAttached = match[0];
    }

    if (!suffixAttached) {
      let node: Node | null = range.endContainer;
      let nextText = "";
      while (node && !nextText) {
        if (node.nextSibling) {
          node = node.nextSibling;
          nextText = node.textContent || "";
        } else {
          node = node.parentNode;
          if (node === rootContainer || (node && node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).id === HOST_ID)) {
            break;
          }
        }
      }
      if (nextText) {
        const match = nextText.match(/^[a-zA-Z0-9'’+#.-]+/);
        if (match) suffixAttached = match[0];
      }
    }

    if (rootContainer) {
      const selRect = range.getBoundingClientRect();
      const allSpans = Array.from(rootContainer.querySelectorAll<HTMLElement>("span, p, div, li, h1, h2, h3, h4"));
      const selCenterY = selRect.top + selRect.height / 2;
      const lineElements = allSpans.filter((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const cY = r.top + r.height / 2;
        return Math.abs(cY - selCenterY) < 18;
      });

      if (lineElements.length > 0) {
        lineElements.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
        surroundingLine = lineElements.map((el) => el.textContent || "").join(" ").replace(/\s+/g, " ").trim();
      }
    }
  } catch (err) {
    console.warn("[Reader AI] extractDomSelectionDetails error in content script:", err);
  }

  return {
    rawSelection,
    prefixAttached,
    suffixAttached,
    surroundingLine
  };
}

function analyzeSelection(selection: Selection, range: Range, surroundingText: string = ""): {
  originalSelection: string;
  resolvedSelection: string;
  selectionType: SelectionData["selectionType"];
} {
  const domDetails = extractDomSelectionDetails(range);
  const raw = selection.toString();
  const original = (raw ?? "").trim();

  if (!original) {
    return { originalSelection: "", resolvedSelection: "", selectionType: "unknown" };
  }

  // Direct Technical Token Check
  if (isTechnicalToken(original)) {
    return { originalSelection: original, resolvedSelection: original, selectionType: "word" };
  }

  // Pure punctuation / symbol handling
  if (/^[^\w\s]+$/.test(original)) {
    let prefixAttached = domDetails.prefixAttached;
    const cleanPrefix = prefixAttached.replace(/^.*[\s.,;:!?()[\]{}'’"]/, "");
    if (cleanPrefix && isTechnicalToken(`${cleanPrefix}${original}`)) {
      return { originalSelection: original, resolvedSelection: `${cleanPrefix}${original}`, selectionType: "word" };
    }
    if (surroundingText) {
      const tokens = extractTokensFromText(surroundingText);
      const techMatch = tokens.find((t) => isTechnicalToken(t) && t.includes(original));
      if (techMatch) {
        return { originalSelection: original, resolvedSelection: techMatch, selectionType: "word" };
      }
    }
    return { originalSelection: original, resolvedSelection: original, selectionType: "unknown" };
  }

  const cleaned = cleanSelection(original);
  if (!cleaned || !/[a-zA-Z0-9]/.test(cleaned)) {
    return { originalSelection: original, resolvedSelection: original, selectionType: "unknown" };
  }

  // Complete Sentence / Passage Check
  const sentenceCount = (cleaned.match(/[.!?](?:\s|$)/g) ?? []).length;
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (sentenceCount > 1 || words.length > 40) {
    return { originalSelection: original, resolvedSelection: cleaned, selectionType: "passage" };
  }
  if (sentenceCount === 1 || (words.length >= 6 && /^[A-Z]/.test(cleaned)) || words.length >= 8 || /[.!?]$/.test(cleaned)) {
    return { originalSelection: original, resolvedSelection: cleaned, selectionType: "sentence" };
  }

  const cleanPrefix = domDetails.prefixAttached.replace(/^.*[\s.,;:!?()[\]{}'’"]/, "");
  const cleanSuffix = domDetails.suffixAttached.replace(/[\s.,;:!?()[\]{}'’"].*$/, "");

  // Corrupted boundary slice detection (e.g. "ient registr" cutting across "patient registration")
  if (words.length > 1 && (cleanPrefix || cleanSuffix)) {
    const lastWord = words[words.length - 1];
    if (cleanSuffix && /^[a-zA-Z0-9'’+#.-]+$/.test(lastWord)) {
      const fullWord = cleanSelection(`${lastWord}${cleanSuffix}`);
      if (fullWord.length > lastWord.length && isMeaningfulWord(fullWord)) {
        return { originalSelection: original, resolvedSelection: fullWord, selectionType: "partial-word" };
      }
    }
  }

  if (words.length > 1 && surroundingText) {
    const tokens = extractTokensFromText(surroundingText);
    const firstWordExact = tokens.some((t) => t.toLowerCase() === words[0].toLowerCase());
    const lastWordExact = tokens.some((t) => t.toLowerCase() === words[words.length - 1].toLowerCase());

    if (!firstWordExact || !lastWordExact) {
      let bestToken = "";
      let bestOverlap = 0;
      for (const token of tokens) {
        for (const w of words) {
          const lowerW = w.toLowerCase();
          const lowerT = token.toLowerCase();
          if (lowerT.startsWith(lowerW) || lowerT.endsWith(lowerW) || (lowerW.length >= 3 && lowerT.includes(lowerW))) {
            if (lowerW.length > bestOverlap) {
              bestOverlap = lowerW.length;
              bestToken = token;
            }
          }
        }
      }
      if (bestToken && bestOverlap >= 3 && isMeaningfulWord(bestToken)) {
        return { originalSelection: original, resolvedSelection: bestToken, selectionType: "partial-word" };
      }
    }
  }

  // Multi-word Phrase Check
  if (words.length > 1 && !/^[+*\/=<>~`|^&%$@!?:;,\s]+/.test(original) && !cleanPrefix && !cleanSuffix) {
    if (words.every((w) => isMeaningfulWord(w))) {
      return { originalSelection: original, resolvedSelection: cleaned, selectionType: "phrase" };
    }
  }

  // Word / Fragment Target Determination
  const targetFragment = words.length === 1 ? words[0] : cleaned;

  if ((cleanPrefix || cleanSuffix) && /^[a-zA-Z0-9'’+#.-]+$/.test(targetFragment)) {
    const fullWord = cleanSelection(`${cleanPrefix}${targetFragment}${cleanSuffix}`);
    if (fullWord.toLowerCase() !== targetFragment.toLowerCase() && fullWord.length > targetFragment.length) {
      if (isMeaningfulWord(fullWord) || isTechnicalToken(fullWord)) {
        return { originalSelection: original, resolvedSelection: fullWord, selectionType: "partial-word" };
      }
    }
  }

  const effectiveContext = (domDetails.surroundingLine ? domDetails.surroundingLine + " " : "") + surroundingText;
  if (effectiveContext && targetFragment.length >= 2) {
    const tokens = extractTokensFromText(effectiveContext);
    const lowerTarget = targetFragment.toLowerCase();

    const exactMatch = tokens.find((t) => t.toLowerCase() === lowerTarget);
    if (exactMatch && isMeaningfulWord(exactMatch) && !/^[+*\/=<>~`|^&%$@!?:;,\s]+/.test(original)) {
      return { originalSelection: original, resolvedSelection: exactMatch, selectionType: "word" };
    }

    const candidate = tokens.find((t) => {
      const lowerT = t.toLowerCase();
      return lowerT !== lowerTarget && (
        lowerT.startsWith(lowerTarget) ||
        lowerT.endsWith(lowerTarget) ||
        (lowerTarget.length >= 3 && lowerT.includes(lowerTarget))
      );
    });

    if (candidate && candidate.length > targetFragment.length && (isMeaningfulWord(candidate) || isTechnicalToken(candidate))) {
      return { originalSelection: original, resolvedSelection: candidate, selectionType: "partial-word" };
    }
  }

  if (isMeaningfulWord(cleaned) || isTechnicalToken(cleaned)) {
    return { originalSelection: original, resolvedSelection: cleaned, selectionType: "word" };
  }

  if (!isMeaningfulWord(cleaned) && words.length === 1 && cleaned.length <= 4) {
    return { originalSelection: original, resolvedSelection: cleaned, selectionType: "unknown" };
  }

  return { originalSelection: original, resolvedSelection: cleaned, selectionType: "word" };
}

function removePopup(): void {
  stopPronunciation();
  try {
    const existingHosts = document.querySelectorAll(`#${HOST_ID}`);
    existingHosts.forEach((host) => host.remove());
  } catch {
    // ignore
  }
  popupHost?.remove();
  popupHost = null;
  popupRoot = null;
  activePopupElement = null;
  activeRange = null;
  interactingWithPopup = false;
}

const SPEAKER_ICON_SVG = `
  <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
    <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
  </svg>
`;

const STOP_ICON_SVG = `
  <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor">
    <rect x="5" y="5" width="14" height="14" rx="2" ry="2"/>
  </svg>
`;

let activeSpeakingButton: HTMLElement | null = null;
let activeSpeakingTimeout: number | null = null;

function setButtonSpeaking(button: HTMLElement, isSpeaking: boolean): void {
  const iconSpan = button.querySelector(".btn-icon");
  const textSpan = button.querySelector(".btn-text");

  if (isSpeaking) {
    button.classList.add("speaking");
    if (iconSpan) iconSpan.innerHTML = STOP_ICON_SVG;
    if (textSpan) textSpan.textContent = "Stop";
    button.removeAttribute("title");
    button.setAttribute("aria-label", "Stop pronunciation");
  } else {
    button.classList.remove("speaking");
    if (iconSpan) iconSpan.innerHTML = SPEAKER_ICON_SVG;
    if (textSpan) textSpan.textContent = "Listen";
    button.removeAttribute("title");
    button.setAttribute("aria-label", "Listen to pronunciation");
  }
}

function clearSpeakingState(): void {
  if (activeSpeakingTimeout !== null) {
    clearTimeout(activeSpeakingTimeout);
    activeSpeakingTimeout = null;
  }
  if (activeSpeakingButton) {
    setButtonSpeaking(activeSpeakingButton, false);
    activeSpeakingButton = null;
  }
}

function stopPronunciation(button?: HTMLElement | null): void {
  clearSpeakingState();

  if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
    try {
      chrome.runtime.sendMessage({ type: "STOP_TTS" }, () => {
        if (chrome.runtime.lastError) { /* ignore */ }
      });
    } catch {
      // ignore
    }
  }

  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      // ignore
    }
  }
}

function playPronunciation(targetWord: string, button?: HTMLElement | null): void {
  console.log("[Reader AI TTS] Listen clicked");
  console.log("[Reader AI TTS] Target:", targetWord);

  const resolvedSelection = targetWord;

  if (!isEligibleForPronunciation(resolvedSelection)) {
    console.log("[Reader AI TTS] Target ineligible for pronunciation:", resolvedSelection);
    if (button) {
      if (button instanceof HTMLButtonElement) button.disabled = true;
      button.style.display = "none";
    }
    return;
  }

  // Toggle off if currently speaking
  if (button && button.classList.contains("speaking")) {
    stopPronunciation(button);
    return;
  }

  clearSpeakingState();

  const spokenText = normalizeSpokenText(resolvedSelection);

  if (button) {
    activeSpeakingButton = button;
    setButtonSpeaking(button, true);
    activeSpeakingTimeout = window.setTimeout(() => {
      clearSpeakingState();
    }, Math.max(5000, spokenText.length * 400));
  }

  const messagePayload = {
    type: "SPEAK_PRONUNCIATION",
    text: spokenText,
    lang: "en-US"
  };

  console.log("[Reader AI TTS] Message sent");

  // Send SPEAK_PRONUNCIATION message to background service worker (chrome.tts)
  if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
    try {
      chrome.runtime.sendMessage(
        messagePayload,
        (response) => {
          if (chrome.runtime.lastError) {
            console.error("[Reader AI TTS] Runtime error in content script:", chrome.runtime.lastError.message);
            fallbackSpeechSynthesis(spokenText, button);
          } else {
            console.log("[Reader AI TTS] Service worker response:", response);
            if (response && (response.success === false || response.ok === false)) {
              console.warn("[Reader AI TTS] Service worker error, using fallback SpeechSynthesis:", response.error);
              fallbackSpeechSynthesis(spokenText, button);
            }
          }
        }
      );
      return;
    } catch (err) {
      console.error("[Reader AI TTS] Exception sending TTS message:", err);
      fallbackSpeechSynthesis(spokenText, button);
      return;
    }
  }

  fallbackSpeechSynthesis(spokenText, button);
}

// Window message bridge for pages communicating with extension TTS
if (typeof window !== "undefined") {
  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || typeof event.data !== "object") return;
    if (
      (event.data.type === "READER_AI_TTS_SPEAK" || event.data.type === "SPEAK_WORD" || event.data.type === "SPEAK_PRONUNCIATION") &&
      typeof event.data.text === "string"
    ) {
      if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({
          type: "SPEAK_PRONUNCIATION",
          text: event.data.text,
          lang: event.data.lang || "en-US"
        });
      }
    } else if (event.data.type === "READER_AI_TTS_STOP" || event.data.type === "STOP_TTS") {
      if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ type: "STOP_TTS" });
      }
    }
  });
}

function fallbackSpeechSynthesis(spokenText: string, button?: HTMLElement | null): void {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    console.warn("[Reader AI TTS] SpeechSynthesis is unavailable in this environment");
    clearSpeakingState();
    return;
  }

  try {
    const utterance = new SpeechSynthesisUtterance(spokenText);
    utterance.lang = "en-US";
    utterance.rate = 0.8;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;

    // Prevent GC mid-speech in Chromium/Chrome
    (window as unknown as { __readerAiActiveUtterance?: SpeechSynthesisUtterance | null }).__readerAiActiveUtterance = utterance;

    utterance.onstart = () => {
      console.log("[Reader AI TTS] SpeechSynthesis fallback started:", spokenText);
    };

    utterance.onend = () => {
      console.log("[Reader AI TTS] SpeechSynthesis fallback ended:", spokenText);
      (window as unknown as { __readerAiActiveUtterance?: SpeechSynthesisUtterance | null }).__readerAiActiveUtterance = null;
      clearSpeakingState();
    };

    utterance.onerror = (e) => {
      console.warn("[Reader AI TTS] SpeechSynthesis fallback error:", e);
      (window as unknown as { __readerAiActiveUtterance?: SpeechSynthesisUtterance | null }).__readerAiActiveUtterance = null;
      clearSpeakingState();
    };

    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
    if (window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
    }
  } catch (e) {
    console.error("[Reader AI TTS] SpeechSynthesis fallback execution error:", e);
    clearSpeakingState();
  }
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (message && typeof message === "object" && "type" in message) {
      if ((message as { type: string }).type === "TTS_STATE_CHANGE") {
        const state = message as { isSpeaking?: boolean };
        if (!state.isSpeaking) {
          clearSpeakingState();
        }
      }
    }
  });
}

function renderPronunciationSection(parent: HTMLElement, targetWord: string, customIpa?: string, rawSelection?: string): HTMLElement | null {
  if (!targetWord || !isEligibleForPronunciation(targetWord)) {
    const section = document.createElement("div");
    section.className = "pronunciation-section";
    const note = document.createElement("div");
    note.style.fontSize = "11px";
    note.style.color = "#858279";
    note.style.fontStyle = "italic";
    note.style.margin = "4px 0";
    note.textContent = "Select a complete word to hear pronunciation.";
    section.appendChild(note);
    parent.appendChild(section);
    return section;
  }

  const pron = resolvePronunciation(targetWord, customIpa);
  if (!pron) return null;
  const ipa = pron.ipa;
  const soundsLike = pron.phonetic;

  console.log("[Reader AI Pronunciation]");
  console.log("Raw selection:", rawSelection || targetWord);
  console.log("Resolved term:", pron.resolvedTerm);
  console.log("Pronunciation target:", pron.resolvedTerm);
  console.log("IPA:", ipa || "none");
  console.log("TTS text:", pron.spokenText || pron.resolvedTerm);

  // Never show fake IPA: if neither reliable IPA nor readable phonetic exists, omit
  if (!ipa && !soundsLike) return null;

  const section = document.createElement("div");
  section.className = "pronunciation-section";

  // Label: PRONUNCIATION
  const label = document.createElement("div");
  label.className = "pronunciation-label";
  label.textContent = "PRONUNCIATION";
  section.appendChild(label);

  // Audio row: 🔊 Listen  /IPA/
  const audioRow = document.createElement("div");
  audioRow.className = "pronunciation-audio-row";

  const listenBtn = document.createElement("button");
  listenBtn.className = "pronunciation-listen-btn";
  listenBtn.type = "button";
  // Remove browser tooltip, accessible aria-label
  listenBtn.setAttribute("aria-label", "Listen to pronunciation");

  const iconSpan = document.createElement("span");
  iconSpan.className = "btn-icon";
  iconSpan.innerHTML = SPEAKER_ICON_SVG;
  listenBtn.appendChild(iconSpan);

  const textSpan = document.createElement("span");
  textSpan.className = "btn-text";
  textSpan.textContent = "Listen";
  listenBtn.appendChild(textSpan);

  listenBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    playPronunciation(pron.spokenText || pron.resolvedTerm, listenBtn);
  });
  audioRow.appendChild(listenBtn);

  if (ipa && isValidIpa(ipa, pron.resolvedTerm)) {
    const ipaSpan = document.createElement("span");
    ipaSpan.className = "pronunciation-ipa";
    ipaSpan.textContent = ipa;
    audioRow.appendChild(ipaSpan);
  }
  section.appendChild(audioRow);

  // Sounds like: readable phonetic pronunciation
  if (soundsLike) {
    const soundsLikeDiv = document.createElement("div");
    soundsLikeDiv.className = "pronunciation-sounds-like";
    soundsLikeDiv.appendChild(document.createTextNode("Sounds like: "));
    const phoneticSpan = document.createElement("span");
    phoneticSpan.className = "phonetic-text";
    phoneticSpan.textContent = soundsLike;
    soundsLikeDiv.appendChild(phoneticSpan);
    section.appendChild(soundsLikeDiv);
  }

  parent.appendChild(section);
  return section;
}

function renderPronunciationRow(parent: HTMLElement, targetWord: string, ipaText?: string, rawSelection?: string): HTMLElement | null {
  return renderPronunciationSection(parent, targetWord, ipaText, rawSelection);
}

function addText(parent: HTMLElement, text: string, className: string): HTMLElement {
  const element = document.createElement("div");
  element.className = className;
  element.textContent = text;
  parent.appendChild(element);
  return element;
}

function clearBody(body: HTMLElement): void {
  body.replaceChildren();
}

function renderLoading(body: HTMLElement, data: SelectionData): void {
  clearBody(body);
  const displayTerm = data.resolvedSelection || data.selectedText;
  addText(body, displayTerm.toLocaleUpperCase(), "selection");
  addText(body, "Analyzing context with Gemini...", "loading");
}

function renderResult(body: HTMLElement, result: Explanation): HTMLButtonElement {
  clearBody(body);
  if (result.type === "word") {
    addText(body, (result.word || "").toLocaleUpperCase(), "selection");
    if (result.partOfSpeech) addText(body, result.partOfSpeech, "part-of-speech");
    renderPronunciationRow(body, result.word || "", result.pronunciation);
    addText(body, "MEANING", "label");
    addText(body, result.meaning || result.simpleMeaning || "", "copy");
    addText(body, "IN THIS CONTEXT", "label");
    addText(body, result.contextExplanation || result.meaning || "", "copy");
    if (result.example) {
      addText(body, "EXAMPLE", "label");
      addText(body, result.example, "example");
    }
  } else if (result.type === "phrase") {
    addText(body, result.phrase || "", "selection");
    if (result.pronunciation) {
      renderPronunciationRow(body, result.phrase || "", result.pronunciation);
    }
    addText(body, "MEANING", "label");
    addText(body, result.meaning || "", "copy");
    addText(body, "IN THIS CONTEXT", "label");
    addText(body, result.contextExplanation || "", "copy");
    if (result.simpleExplanation) {
      addText(body, "SIMPLE EXPLANATION", "label");
      addText(body, result.simpleExplanation, "copy");
    }
  } else {
    addText(body, result.selectedText || "", "selection");
    addText(body, "EXPLANATION", "label");
    addText(body, result.simpleExplanation || "", "copy");
    if (Array.isArray(result.keyPoints) && result.keyPoints.length > 0) {
      addText(body, "KEY POINTS", "label");
      result.keyPoints.forEach((point) => addText(body, `• ${point}`, "copy"));
    }
  }

  const save = document.createElement("button");
  save.className = "action secondary";
  save.type = "button";
  save.disabled = true;
  save.textContent = "+ Save to Vocabulary (coming later)";
  body.appendChild(save);
  return save;
}

function renderError(body: HTMLElement, data: SelectionData, errorMsg: string, retry: () => void): void {
  clearBody(body);
  addText(body, (data.resolvedSelection || data.selectedText).toLocaleUpperCase(), "selection");

  const lower = (errorMsg || "").toLowerCase();
  const isBusy = lower.includes("busy") || lower.includes("demand") || lower.includes("unavailable") || lower.includes("temporarily") || lower.includes("503") || lower.includes("429");

  const title = isBusy ? "AI is temporarily busy." : "Unable to explain this selection right now.";
  const copy = isBusy ? "AI is temporarily busy. Please try again." : (errorMsg || "Something went wrong while communicating with Gemini.");

  addText(body, title, "error-title");
  addText(body, copy, "error-copy");

  const tryAgain = document.createElement("button");
  tryAgain.className = "action retry-action-btn";
  tryAgain.type = "button";
  tryAgain.textContent = "Retry";
  tryAgain.addEventListener("click", (e) => {
    e.stopPropagation();
    retry();
  });
  body.appendChild(tryAgain);
}

function isExplanation(value: unknown): value is Explanation {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (item.type === "word") {
    return typeof item.word === "string" && (typeof item.meaning === "string" || typeof item.contextExplanation === "string");
  }
  if (item.type === "phrase") {
    return typeof item.phrase === "string" && (typeof item.meaning === "string" || typeof item.contextExplanation === "string");
  }
  if (item.type === "explanation") {
    return typeof item.selectedText === "string" && typeof item.simpleExplanation === "string";
  }
  return false;
}

function positionPopup(popup: HTMLElement, selectionRect: DOMRect): void {
  // Allow measuring unconstrained natural content height up to MAX_POPUP_HEIGHT
  popup.style.maxHeight = `${MAX_POPUP_HEIGHT}px`;

  const renderedRect = popup.getBoundingClientRect();
  const width = renderedRect.width || POPUP_WIDTH;
  const naturalHeight = popup.scrollHeight || renderedRect.height || 200;

  // Horizontal positioning: center relative to selection, clamped within safe margins
  const selectionCenter = selectionRect.left + selectionRect.width / 2;
  const targetLeft = selectionCenter - width / 2;
  const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN);
  const popupLeft = Math.max(VIEWPORT_MARGIN, Math.min(targetLeft, maxLeft));

  // Vertical available spaces:
  const spaceBelow = window.innerHeight - selectionRect.bottom - SELECTION_GAP - VIEWPORT_MARGIN;
  const spaceAbove = selectionRect.top - SELECTION_GAP - VIEWPORT_MARGIN;

  let placeBelow: boolean;
  let availableSpace: number;

  if (spaceBelow >= naturalHeight) {
    // 1. Enough room below for full natural content
    placeBelow = true;
    availableSpace = spaceBelow;
  } else if (spaceAbove >= naturalHeight) {
    // 2. Not enough room below, but enough room above for full natural content
    placeBelow = false;
    availableSpace = spaceAbove;
  } else {
    // 3. Neither side fits completely -> choose the side with more available space
    if (spaceBelow >= spaceAbove) {
      placeBelow = true;
      availableSpace = spaceBelow;
    } else {
      placeBelow = false;
      availableSpace = spaceAbove;
    }
  }

  // Constrain max-height strictly based on the available space on the chosen side
  const calculatedMaxHeight = Math.max(120, Math.min(availableSpace, MAX_POPUP_HEIGHT));
  popup.style.maxHeight = `${Math.floor(calculatedMaxHeight)}px`;

  // Calculate top coordinate based on placement direction
  let popupTop: number;
  if (placeBelow) {
    popupTop = selectionRect.bottom + SELECTION_GAP;
  } else {
    const currentHeight = popup.getBoundingClientRect().height;
    popupTop = selectionRect.top - SELECTION_GAP - currentHeight;
  }

  // Ensure popup is strictly within viewport bounds [VIEWPORT_MARGIN, window.innerHeight - currentHeight - VIEWPORT_MARGIN]
  const currentHeight = popup.getBoundingClientRect().height;
  const clampedTop = Math.max(
    VIEWPORT_MARGIN,
    Math.min(popupTop, Math.max(VIEWPORT_MARGIN, window.innerHeight - currentHeight - VIEWPORT_MARGIN))
  );

  popup.style.left = `${Math.round(popupLeft)}px`;
  popup.style.top = `${Math.round(clampedTop)}px`;
}

function updateActivePosition(event?: Event): void {
  if (event && popupHost) {
    const target = event.target as Node | null;
    if (target && (target === popupHost || popupHost.contains(target) || popupRoot?.contains(target))) {
      return;
    }
  }
  if (!popupHost || !activeRange || !activePopupElement) return;

  const rect = activeRange.getBoundingClientRect();

  // If selection collapsed or scrolled completely off-screen:
  if (
    (rect.width === 0 && rect.height === 0) ||
    rect.bottom < 0 ||
    rect.top > window.innerHeight ||
    rect.right < 0 ||
    rect.left > window.innerWidth
  ) {
    popupHost.style.display = "none";
  } else {
    popupHost.style.display = "block";
    positionPopup(activePopupElement, rect);
  }
}

function requestExplanation(data: SelectionData, body: HTMLElement, popup: HTMLElement): void {
  renderLoading(body, data);
  positionPopup(popup, data.rect);

  const isWordOrPhrase = data.selectionType === "word" || data.selectionType === "partial-word" || data.selectionType === "phrase";
  const minimalContext = isWordOrPhrase ? data.sentence : (data.sentence || data.paragraph);

  const payload = {
    originalSelection: data.originalSelection,
    resolvedSelection: data.resolvedSelection,
    selectedText: data.resolvedSelection || data.selectedText,
    selectionType: data.selectionType,
    context: minimalContext,
    sentence: data.sentence,
    paragraph: minimalContext,
    surroundingContext: minimalContext,
    pageTitle: data.pageTitle,
    sourceUrl: data.sourceUrl,
    sourceType: data.sourceType
  };

  chrome.runtime.sendMessage(
    {
      type: "EXPLAIN",
      payload
    },
    (response: ExplainResponse | undefined) => {
      if (chrome.runtime.lastError || !response || !response.ok || !isExplanation(response.result)) {
        const errorDetail = response && !response.ok ? response.error : (chrome.runtime.lastError?.message || "Failed to get AI explanation.");
        console.error("[Reader AI Extension] Explain failed:", errorDetail);
        renderError(body, data, errorDetail, () => requestExplanation(data, body, popup));
      } else {
        renderResult(body, response.result);
      }
      positionPopup(popup, data.rect);
    }
  );
}

function renderPopup(data: SelectionData, range: Range): void {
  // Ensure only ONE popup exists at a time
  removePopup();

  activeRange = range.cloneRange();

  popupHost = document.createElement("div");
  popupHost.id = HOST_ID;
  popupHost.style.position = "fixed";
  popupHost.style.top = "0";
  popupHost.style.left = "0";
  popupHost.style.width = "100%";
  popupHost.style.height = "100%";
  popupHost.style.zIndex = "2147483647";
  popupHost.style.pointerEvents = "none";
  document.documentElement.appendChild(popupHost);

  popupRoot = popupHost.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    .popup {
      position: fixed;
      width: min(${POPUP_WIDTH}px, calc(100vw - ${VIEWPORT_MARGIN * 2}px));
      max-height: min(80vh, ${MAX_POPUP_HEIGHT}px);
      display: flex;
      flex-direction: column;
      box-sizing: border-box;
      pointer-events: auto;
      color: #20201e;
      background: #fbfaf7;
      border: 1px solid #d8d6ce;
      border-radius: 10px;
      box-shadow: 0 14px 38px rgba(32, 32, 30, .18), 0 2px 8px rgba(32, 32, 30, .08);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      overflow: hidden;
      overscroll-behavior: contain;
    }
    .header {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px 10px;
      border-bottom: 1px solid #e7e5de;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: .14em;
      background: #fbfaf7;
      user-select: none;
    }
    .brand { display: flex; align-items: center; gap: 7px; }
    .spark { font-size: 15px; font-weight: 400; color: #20201e; }
    button { border: 0; cursor: pointer; font: inherit; }
    .close {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: transparent;
      color: #77756e;
      font-size: 18px;
      line-height: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.1s ease;
    }
    .close:hover { background: #eeece5; color: #20201e; }
    .body {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
      overscroll-behavior: contain;
      padding: 14px 16px 16px;
      scrollbar-width: thin;
      scrollbar-color: #d8d6ce transparent;
    }
    .body::-webkit-scrollbar {
      width: 6px;
    }
    .body::-webkit-scrollbar-track {
      background: transparent;
    }
    .body::-webkit-scrollbar-thumb {
      background-color: #d8d6ce;
      border-radius: 3px;
    }
    .body::-webkit-scrollbar-thumb:hover {
      background-color: #bfbcb2;
    }
    .selection {
      font-family: Georgia, serif;
      font-size: 20px;
      line-height: 1.25;
      font-weight: 600;
      overflow-wrap: anywhere;
      color: #1a1a18;
    }
    .part-of-speech { margin-top: 4px; color: #858279; font-size: 11px; font-style: italic; }
    .pronunciation-section {
      display: flex;
      flex-direction: column;
      gap: 5px;
      margin-top: 10px;
      margin-bottom: 4px;
      padding: 8px 10px;
      background: #f4f3ee;
      border: 1px solid #e7e5de;
      border-radius: 6px;
    }
    .pronunciation-label {
      color: #858279;
      font-size: 9.5px;
      font-weight: 700;
      letter-spacing: .16em;
      text-transform: uppercase;
      line-height: 1;
    }
    .pronunciation-audio-row {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .pronunciation-listen-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border: 1px solid #d8d6ce;
      border-radius: 14px;
      background: #ffffff;
      color: #20201e;
      font-size: 11.5px;
      font-weight: 600;
      cursor: pointer;
      line-height: 1;
      transition: all 0.15s ease;
      flex-shrink: 0;
    }
    .pronunciation-listen-btn:hover {
      background: #eeece5;
      border-color: #bebcb4;
    }
    .pronunciation-listen-btn.speaking {
      background: #20201e;
      color: #ffffff;
      border-color: #20201e;
      animation: reader-ai-pulse 1s ease-in-out infinite;
    }
    .pronunciation-listen-btn .btn-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .pronunciation-listen-btn svg {
      display: block;
      fill: currentColor;
    }
    .pronunciation-listen-btn:disabled {
      opacity: 0.4;
      cursor: default;
    }
    .pronunciation-ipa {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Lucida Grande", sans-serif;
      font-size: 13px;
      color: #5d5b55;
      letter-spacing: 0.02em;
    }
    .pronunciation-sounds-like {
      font-size: 11.5px;
      color: #77756e;
      line-height: 1.35;
    }
    .pronunciation-sounds-like .phonetic-text {
      font-weight: 600;
      color: #20201e;
    }
    .pronunciation-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 6px;
      margin-bottom: 2px;
    }
    .speaker-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      padding: 0;
      border: 1px solid #d8d6ce;
      border-radius: 50%;
      background: #f4f3ee;
      color: #5d5b55;
      cursor: pointer;
      transition: all 0.15s ease;
      flex-shrink: 0;
    }
    .speaker-btn:hover {
      background: #e9e7df;
      color: #20201e;
      border-color: #bebcb4;
    }
    .speaker-btn.speaking {
      background: #20201e;
      color: #fff;
      border-color: #20201e;
      animation: reader-ai-pulse 1s ease-in-out infinite;
    }
    .speaker-btn:disabled {
      opacity: 0.4;
      cursor: default;
    }
    .label { margin-top: 14px; color: #858279; font-size: 10px; font-weight: 700; letter-spacing: .16em; }
    .context {
      margin-top: 6px;
      color: #5d5b55;
      font-family: Georgia, serif;
      font-size: 13px;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }
    .copy, .example { margin-top: 6px; color: #5d5b55; font-family: Georgia, serif; font-size: 13px; line-height: 1.45; }
    .example { font-style: italic; }
    .loading { display: flex; align-items: center; gap: 6px; margin-top: 20px; color: #5d5b55; font-family: Georgia, serif; font-size: 13px; }
    .loading::after { content: ""; width: 5px; height: 5px; border-radius: 50%; background: #5d5b55; animation: reader-ai-pulse 1s ease-in-out infinite; }
    .error-title { margin-top: 18px; font-family: Georgia, serif; font-size: 16px; font-weight: 600; color: #b91c1c; }
    .error-copy { margin-top: 6px; color: #5d5b55; font-family: Georgia, serif; font-size: 13px; line-height: 1.45; }
    .action {
      width: 100%;
      margin-top: 16px;
      padding: 9px 12px;
      border-radius: 6px;
      background: #20201e;
      color: #fff;
      font-size: 12px;
      font-weight: 600;
      transition: background 0.15s ease;
    }
    .action:hover { background: #373633; }
    .secondary { background: #eeece5; color: #5d5b55; }
    .secondary:hover { background: #e3e0d8; }
    .action:disabled { cursor: default; opacity: .48; }

    /* Dark Theme */
    .popup[data-theme="dark"] {
      background: #18181b;
      border-color: #2e2e33;
      box-shadow: 0 16px 44px rgba(0, 0, 0, 0.75), 0 4px 14px rgba(0, 0, 0, 0.5);
      color: #e4e4e7;
    }
    .popup[data-theme="dark"] .header {
      background: #18181b;
      border-bottom-color: #27272a;
      color: #f4f4f5;
    }
    .popup[data-theme="dark"] .spark {
      color: #facc15;
    }
    .popup[data-theme="dark"] .close {
      color: #a1a1aa;
    }
    .popup[data-theme="dark"] .close:hover {
      background: #27272a;
      color: #ffffff;
    }
    .popup[data-theme="dark"] .body {
      scrollbar-color: #38383e transparent;
    }
    .popup[data-theme="dark"] .body::-webkit-scrollbar-thumb {
      background-color: #38383e;
    }
    .popup[data-theme="dark"] .selection {
      color: #ffffff;
    }
    .popup[data-theme="dark"] .part-of-speech {
      color: #a1a1aa;
    }
    .popup[data-theme="dark"] .pronunciation-section {
      background: #202024;
      border-color: #2e2e33;
    }
    .popup[data-theme="dark"] .pronunciation-label {
      color: #a1a1aa;
    }
    .popup[data-theme="dark"] .pronunciation-listen-btn {
      background: #27272a;
      border-color: #3f3f46;
      color: #f4f4f5;
    }
    .popup[data-theme="dark"] .pronunciation-listen-btn:hover {
      background: #323238;
      border-color: #52525b;
    }
    .popup[data-theme="dark"] .pronunciation-listen-btn.speaking {
      background: #2563eb;
      border-color: #3b82f6;
      color: #ffffff;
    }
    .popup[data-theme="dark"] .pronunciation-sounds-like {
      color: #a1a1aa;
    }
    .popup[data-theme="dark"] .pronunciation-sounds-like .phonetic-text {
      color: #ffffff;
    }
    .popup[data-theme="dark"] .pronunciation-ipa {
      color: #93c5fd;
    }
    .popup[data-theme="dark"] .speaker-btn {
      background: #27272a;
      border-color: #3f3f46;
      color: #e4e4e7;
    }
    .popup[data-theme="dark"] .speaker-btn:hover {
      background: #323238;
      color: #ffffff;
      border-color: #52525b;
    }
    .popup[data-theme="dark"] .speaker-btn.speaking {
      background: #2563eb;
      border-color: #3b82f6;
      color: #ffffff;
    }
    .popup[data-theme="dark"] .label {
      color: #a1a1aa;
    }
    .popup[data-theme="dark"] .context,
    .popup[data-theme="dark"] .copy,
    .popup[data-theme="dark"] .example {
      color: #d4d4d8;
    }
    .popup[data-theme="dark"] .action {
      background: #f4f4f5;
      color: #18181b;
    }
    .popup[data-theme="dark"] .action:hover {
      background: #ffffff;
    }
    .popup[data-theme="dark"] .secondary {
      background: #27272a;
      color: #e4e4e7;
    }
    .popup[data-theme="dark"] .secondary:hover {
      background: #323238;
    }

    @keyframes reader-ai-pulse { 0%, 100% { opacity: .25; transform: scale(.75); } 50% { opacity: 1; transform: scale(1.1); } }
  `;
  popupRoot.appendChild(style);

  const popup = document.createElement("section");
  popup.className = "popup";
  popup.setAttribute("role", "dialog");
  popup.setAttribute("aria-label", "Reader AI context");
  popup.setAttribute("data-theme", currentTheme);

  const header = document.createElement("header");
  header.className = "header";
  const brand = document.createElement("div");
  brand.className = "brand";
  addText(brand, "✦", "spark");
  addText(brand, "READER AI", "");
  header.appendChild(brand);

  const close = document.createElement("button");
  close.className = "close";
  close.type = "button";
  close.setAttribute("aria-label", "Close Reader AI popup");
  close.textContent = "×";
  close.addEventListener("click", (e) => {
    e.stopPropagation();
    removePopup();
  });
  header.appendChild(close);
  popup.appendChild(header);

  const body = document.createElement("div");
  body.className = "body";

  // Prevent clicks and scroll gestures inside the popup from bubbling to page or collapsing popup
  popup.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    interactingWithPopup = true;
  });
  popup.addEventListener("mousedown", (e) => {
    e.stopPropagation();
    interactingWithPopup = true;
  });
  popup.addEventListener("click", (e) => {
    e.stopPropagation();
    interactingWithPopup = true;
  });
  popup.addEventListener("wheel", (e: WheelEvent) => {
    e.stopPropagation();
    if (e.target !== body && !body.contains(e.target as Node)) {
      body.scrollTop += e.deltaY;
    }
  }, { passive: true });
  popup.addEventListener("touchstart", (e) => {
    e.stopPropagation();
    interactingWithPopup = true;
  }, { passive: true });
  popup.addEventListener("touchmove", (e) => {
    e.stopPropagation();
  }, { passive: true });

  if (isCamelCase(data.originalSelection)) {
    const resolved = splitCamelCase(data.originalSelection);
    addText(body, resolved.toLocaleUpperCase(), "selection");
    addText(body, `You selected: "${data.originalSelection}"`, "part-of-speech");
    if (isEligibleForPronunciation(resolved, data.selectionType)) {
      renderPronunciationRow(body, resolved, undefined, data.originalSelection);
    }
  } else if (data.selectionType === "partial-word") {
    addText(body, "DID YOU MEAN?", "label");
    addText(body, data.resolvedSelection.toLocaleUpperCase(), "selection");
    addText(body, `You selected: "${data.originalSelection}"`, "part-of-speech");
    if (isEligibleForPronunciation(data.resolvedSelection, data.selectionType)) {
      renderPronunciationRow(body, data.resolvedSelection, undefined, data.originalSelection);
    }
  } else if (data.selectionType === "word" || data.selectionType === "phrase") {
    addText(body, data.resolvedSelection.toLocaleUpperCase(), "selection");
    if (isEligibleForPronunciation(data.resolvedSelection, data.selectionType)) {
      renderPronunciationRow(body, data.resolvedSelection, undefined, data.originalSelection);
    } else if (data.selectionType === "word") {
      renderPronunciationRow(body, data.resolvedSelection, undefined, data.originalSelection);
    }
  } else {
    addText(body, data.resolvedSelection.toLocaleUpperCase(), "selection");
    if (isEligibleForPronunciation(data.resolvedSelection, data.selectionType)) {
      renderPronunciationRow(body, data.resolvedSelection, undefined, data.originalSelection);
    }
  }

  addText(body, "CONTEXT", "label");
  addText(body, data.sentence || data.paragraph, "context");

  const explain = document.createElement("button");
  explain.className = "action";
  explain.type = "button";
  explain.textContent = data.selectionType === "partial-word"
    ? `Explain "${data.resolvedSelection}"`
    : data.selectionType === "passage"
      ? "Summarize with AI"
      : "Explain with AI";

  explain.addEventListener("click", (e) => {
    e.stopPropagation();
    requestExplanation(data, body, popup);
  });
  body.appendChild(explain);

  popup.appendChild(body);
  popupRoot.appendChild(popup);
  activePopupElement = popup;

  positionPopup(popup, data.rect);
}

function inspectSelection(): void {
  // If the user is on the native Reader AI app / PDF reader, do not inject extension popup
  if (isReaderAiNativePage()) {
    removePopup();
    return;
  }

  // If the user is actively interacting with the popup, don't re-inspect or remove
  if (interactingWithPopup) return;

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    removePopup();
    return;
  }

  const range = selection.getRangeAt(0);
  const container = getClosestTextContainer(range);
  const selectedParagraph = extractCleanTextFromContainer(container, range.commonAncestorContainer);
  const analysis = analyzeSelection(selection, range, selectedParagraph);

  if (analysis.selectionType === "unknown" || !analysis.originalSelection) {
    removePopup();
    return;
  }

  const rect = range.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) {
    removePopup();
    return;
  }

  const sentence = extractSentenceFromText(selectedParagraph, analysis.resolvedSelection || analysis.originalSelection);

  renderPopup({
    originalSelection: analysis.originalSelection,
    resolvedSelection: analysis.resolvedSelection,
    selectedText: analysis.resolvedSelection || analysis.originalSelection,
    selectionType: analysis.selectionType,
    sentence,
    paragraph: selectedParagraph.slice(0, 4000),
    surroundingContext: selectedParagraph.slice(0, 8000),
    pageTitle: document.title,
    sourceUrl: window.location.href,
    sourceType: "webpage",
    rect
  }, range);
}

// Selection event listeners for webpage
document.addEventListener("mouseup", () => window.setTimeout(inspectSelection, 10));

document.addEventListener("pointerdown", (event) => {
  if (popupHost && !popupHost.contains(event.target as Node)) {
    interactingWithPopup = false;
  }
}, true);

document.addEventListener("mousedown", (event) => {
  if (popupHost && !popupHost.contains(event.target as Node)) {
    interactingWithPopup = false;
  }
}, true);

document.addEventListener("keyup", (event) => {
  if (event.key === "Shift" || event.key.startsWith("Arrow")) {
    window.setTimeout(inspectSelection, 10);
  }
});

document.addEventListener("selectionchange", () => {
  if (interactingWithPopup) return;
  window.setTimeout(() => {
    if (interactingWithPopup) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.toString().trim()) {
      removePopup();
    }
  }, 100);
});

// Real-time viewport updates on scroll and resize
window.addEventListener("scroll", updateActivePosition, { passive: true, capture: true });
window.addEventListener("resize", updateActivePosition, { passive: true });
