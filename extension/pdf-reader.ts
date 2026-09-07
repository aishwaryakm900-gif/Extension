import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  resolvePronunciation,
  isCamelCase,
  splitCamelCase,
  isEligibleForPronunciation,
  normalizeSpokenText,
  isValidIpa
} from "./pronunciation";

const viewer = document.querySelector<HTMLElement>("#viewer");
const title = document.querySelector<HTMLElement>("#document-title");
const params = new URLSearchParams(window.location.search);
const sourceUrl = params.get("url");
let popup: HTMLElement | null = null;
let interactingWithPopup = false;
const POPUP_WIDTH = 320;
const VIEWPORT_MARGIN = 16;
const SELECTION_GAP = 8;
const MAX_POPUP_HEIGHT = 650;

pdfjsLib.GlobalWorkerOptions.workerSrc = "pdf.worker.js";

if (!viewer || !sourceUrl) {
  if (viewer) viewer.textContent = "No PDF was provided.";
} else {
  void loadPdf(sourceUrl);
}

async function loadPdf(url: string): Promise<void> {
  try {
    const documentProxy = await pdfjsLib.getDocument({ url }).promise;
    viewer?.replaceChildren();
    title && (title.textContent = `${documentProxy.numPages} PAGES`);
    for (let pageNumber = 1; pageNumber <= documentProxy.numPages; pageNumber += 1) {
      await renderPage(documentProxy, pageNumber);
    }
  } catch (error) {
    console.error("Reader AI PDF load failed", error);
    if (viewer) viewer.textContent = "Unable to load this PDF. Text-based PDFs are supported; scanned PDFs require OCR later.";
  }
}

async function renderPage(documentProxy: pdfjsLib.PDFDocumentProxy, pageNumber: number): Promise<void> {
  const page = await documentProxy.getPage(pageNumber);
  const scale = 1.25;
  const viewport = page.getViewport({ scale });
  const wrapper = document.createElement("section");
  wrapper.className = "page";
  wrapper.dataset.pageNumber = String(pageNumber);
  wrapper.style.width = `${viewport.width}px`;
  wrapper.style.height = `${viewport.height}px`;
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  wrapper.appendChild(canvas);
  const textLayer = document.createElement("div");
  textLayer.className = "textLayer";
  textLayer.style.width = `${viewport.width}px`;
  textLayer.style.height = `${viewport.height}px`;
  textLayer.style.setProperty("--total-scale-factor", String(scale));
  wrapper.appendChild(textLayer);
  viewer?.appendChild(wrapper);

  await (page.render as any)({ canvasContext: canvas.getContext("2d")!, viewport, canvas }).promise;
  const content = await page.getTextContent();
  try {
    const textLayerObj = new pdfjsLib.TextLayer({
      textContentSource: content,
      container: textLayer,
      viewport
    });
    await textLayerObj.render();
  } catch (e) {
    console.error("Extension TextLayer render failed, using fallback spans", e);
    for (const item of content.items) {
      if (!("str" in item) || !item.str) continue;
      const span = document.createElement("span");
      span.textContent = item.str;
      const transform = pdfjsLib.Util.transform(viewport.transform, item.transform);
      span.style.left = `${transform[4]}px`;
      span.style.top = `${transform[5] - item.height * scale}px`;
      span.style.fontSize = `${item.height * scale}px`;
      span.style.fontFamily = item.fontName ?? "sans-serif";
      textLayer.appendChild(span);
    }
  }
}

document.addEventListener("mouseup", () => window.setTimeout(handleSelection, 0));

document.addEventListener("pointerdown", (event) => {
  if (popup && !popup.contains(event.target as Node)) {
    interactingWithPopup = false;
  }
}, true);

document.addEventListener("mousedown", (event) => {
  if (popup && !popup.contains(event.target as Node)) {
    interactingWithPopup = false;
  }
}, true);

document.addEventListener("selectionchange", () => window.setTimeout(() => {
  if (interactingWithPopup) return;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) removePopup();
}, 0));

type PdfSelectionData = {
  originalSelection: string;
  resolvedSelection: string;
  selectedText: string;
  selectionType: "word" | "partial-word" | "phrase" | "sentence" | "passage" | "unknown";
  sentence: string;
  context: string;
  pageNumber: number;
  rect: DOMRect;
};

const COMMON_TECH_TOKENS = new Set([
  "c++", "c#", "f#", ".net", "asp.net", "node.js", "next.js", "vue.js", "react.js",
  "nuxt.js", "nest.js", "express.js", "three.js", "d3.js", "angular.js", "backbone.js",
  "rxjs", "graphql", "postgresql", "mysql", "nosql", "sqlite", "mongodb",
  "tensorflow", "pytorch", "opencv", "langchain", "langgraph", "scikit-learn",
  "rag", "llm", "nlp", "ocr", "api", "sdk", "cli", "gui", "ui", "ux", "css", "html"
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
  if (lower.length === 1) return lower === "a" || lower === "i";
  if (!/[aeiouy]/.test(lower)) return false;
  if (/zq|qj|qk|qx|qz|jx|xj|vf|vj|vk|vx|vz|zf|zj|zk|zx/.test(lower)) return false;
  if (/q(?!u)/.test(lower) && lower !== "faq") return false;
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
  // e.g. "s. Now that he knew..." -> "Now that he knew..."
  text = text.replace(/^[a-zA-Z0-9]{1,2}[.!?]\s+(?=[A-Z0-9])/g, "");
  text = text.replace(/^[.!?]\s+(?=[A-Z0-9])/g, "");

  // 2. Clean leading symbol/punctuation bleed preceding an alphanumeric token:
  // e.g. "++, JavaS" -> "JavaS"
  if (!isTechnicalToken(text)) {
    text = text.replace(/^[+*\/=<>~`|^&%$@!?:;,\s]+(?=[a-zA-Z0-9])/g, "");
  }

  // 3. Clean leading 1-letter boundary bleed for single words / short phrases:
  // e.g. "t night" -> "night"
  text = text.replace(/^([b-hj-zB-HJ-Z])\s+([a-zA-Z]{2,}.*)$/g, "$2");

  // 4. Clean trailing bleed after sentence terminators:
  // e.g. "lifestyle. S" -> "lifestyle."
  text = text.replace(/([.!?])\s+[a-zA-Z0-9]{1,2}$/g, "$1");

  // 5. Clean trailing stray punctuation:
  if (!isTechnicalToken(text)) {
    text = text.replace(/\s*[,;:|\/]+$/g, "");
  }

  return text.trim();
}

function resolveSelectionCandidate(
  selectedText: string,
  prefixAttached: string = "",
  suffixAttached: string = "",
  surroundingText: string = ""
): { originalSelection: string; resolvedSelection: string; selectionType: PdfSelectionData["selectionType"] } {
  const original = (selectedText ?? "").trim().replace(/\s+/g, " ");
  if (!original) {
    return { originalSelection: "", resolvedSelection: "", selectionType: "unknown" };
  }

  // 1. Direct Technical Token Check
  if (isTechnicalToken(original)) {
    return { originalSelection: original, resolvedSelection: original, selectionType: "word" };
  }

  // 2. Pure punctuation / symbol handling (e.g. selecting "++" next to "C")
  if (/^[^\w\s]+$/.test(original)) {
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

  // 4. Complete Sentence / Passage Check
  const sentenceCount = (cleaned.match(/[.!?](?:\s|$)/g) ?? []).length;
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (sentenceCount > 1 || words.length > 40) {
    return { originalSelection: original, resolvedSelection: cleaned, selectionType: "passage" };
  }
  if (sentenceCount === 1 || (words.length >= 6 && /^[A-Z]/.test(cleaned)) || words.length >= 8 || /[.!?]$/.test(cleaned)) {
    return { originalSelection: original, resolvedSelection: cleaned, selectionType: "sentence" };
  }

  const cleanPrefix = prefixAttached.replace(/^.*[\s.,;:!?()[\]{}'’"]/, "");
  const cleanSuffix = suffixAttached.replace(/[\s.,;:!?()[\]{}'’"].*$/, "");
  const hasPrefix = cleanPrefix.length > 0 && /^[a-zA-Z0-9'’+#.-]+$/.test(cleanPrefix);
  const hasSuffix = cleanSuffix.length > 0 && /^[a-zA-Z0-9'’+#.-]+$/.test(cleanSuffix);

  // 5. Corrupted boundary slice detection (e.g. "ient registr" cutting across "patient registration")
  if (words.length > 1 && (hasPrefix || hasSuffix)) {
    const lastWord = words[words.length - 1];
    if (hasSuffix && /^[a-zA-Z0-9'’+#.-]+$/.test(lastWord)) {
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
          if (lowerT.startsWith(lowerW) || lowerT.endsWith(lowerW) || (lowerW.length >= 4 && lowerT.includes(lowerW))) {
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

  // 6. Valid Multi-Word Phrase Check
  if (words.length > 1 && !/^[+*\/=<>~`|^&%$@!?:;,\s]+/.test(original) && !hasPrefix && !hasSuffix) {
    if (words.every((w) => isMeaningfulWord(w))) {
      return { originalSelection: original, resolvedSelection: cleaned, selectionType: "phrase" };
    }
  }

  // 7. Word / Fragment Target Determination
  const targetFragment = words.length === 1 ? words[0] : cleaned;

  if ((hasPrefix || hasSuffix) && /^[a-zA-Z0-9'’+#.-]+$/.test(targetFragment)) {
    const fullWord = cleanSelection(`${cleanPrefix}${targetFragment}${cleanSuffix}`);
    if (fullWord.toLowerCase() !== targetFragment.toLowerCase() && fullWord.length > targetFragment.length && isMeaningfulWord(fullWord)) {
      return { originalSelection: original, resolvedSelection: fullWord, selectionType: "partial-word" };
    }
  }

  if (surroundingText && targetFragment.length >= 2) {
    const tokens = extractTokensFromText(surroundingText);
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

    if (candidate && candidate.length > targetFragment.length && isMeaningfulWord(candidate)) {
      return { originalSelection: original, resolvedSelection: candidate, selectionType: "partial-word" };
    }
  }

  if (isMeaningfulWord(cleaned)) {
    return { originalSelection: original, resolvedSelection: cleaned, selectionType: "word" };
  }

  return { originalSelection: original, resolvedSelection: cleaned, selectionType: "unknown" };
}

function extractDomSelectionDetails(range: Range, containerElement?: HTMLElement | null): {
  rawSelection: string;
  prefixAttached: string;
  suffixAttached: string;
  surroundingLine: string;
  enclosingWord?: string;
} {
  const rawSelection = range.toString().trim();
  let prefixAttached = "";
  let suffixAttached = "";

  if (range.startContainer.nodeType === Node.TEXT_NODE) {
    const textNode = range.startContainer as Text;
    const fullText = textNode.textContent || "";
    const sliceBefore = fullText.slice(0, range.startOffset);
    const match = sliceBefore.match(/[a-zA-Z0-9'’+#.-]+$/);
    if (match) {
      prefixAttached = match[0];
    }

    if (!/\s/.test(sliceBefore)) {
      let curr = textNode.parentElement?.previousElementSibling as HTMLElement | null;
      while (curr && !curr.classList.contains("reader-ai-popup") && !curr.classList.contains("popup")) {
        const text = curr.textContent || "";
        if (!text) break;
        const trailing = text.match(/[a-zA-Z0-9'’+#.-]+$/);
        if (trailing) {
          prefixAttached = trailing[0] + prefixAttached;
        }
        if (/\s/.test(text) || !trailing) {
          break;
        }
        curr = curr.previousElementSibling as HTMLElement | null;
      }
    }
  }

  if (range.endContainer.nodeType === Node.TEXT_NODE) {
    const textNode = range.endContainer as Text;
    const fullText = textNode.textContent || "";
    const sliceAfter = fullText.slice(range.endOffset);
    const match = sliceAfter.match(/^[a-zA-Z0-9'’+#.-]+/);
    if (match) {
      suffixAttached = match[0];
    }

    if (!/\s/.test(sliceAfter)) {
      let curr = textNode.parentElement?.nextElementSibling as HTMLElement | null;
      while (curr && !curr.classList.contains("reader-ai-popup") && !curr.classList.contains("popup")) {
        const text = curr.textContent || "";
        if (!text) break;
        const leading = text.match(/^[a-zA-Z0-9'’+#.-]+/);
        if (leading) {
          suffixAttached = suffixAttached + leading[0];
        }
        if (/\s/.test(text) || !leading) {
          break;
        }
        curr = curr.nextElementSibling as HTMLElement | null;
      }
    }
  }

  let surroundingLine = "";
  try {
    const rect = range.getBoundingClientRect();
    const searchRoot =
      containerElement ||
      (range.startContainer.parentElement?.closest(".textLayer, .page, article, p, [role='region']") as HTMLElement | null) ||
      document.body;

    if (searchRoot && rect.width > 0 && typeof searchRoot.querySelectorAll === "function") {
      const spans = Array.from(searchRoot.querySelectorAll<HTMLElement>("span"));
      if (spans.length > 0) {
        const selCenterY = rect.top + rect.height / 2;
        const sameLineSpans = spans.filter((s) => {
          const sRect = s.getBoundingClientRect();
          if (sRect.width === 0 || sRect.height === 0) return false;
          const sCenterY = sRect.top + sRect.height / 2;
          return Math.abs(sCenterY - selCenterY) < 18;
        });

        if (sameLineSpans.length > 0) {
          sameLineSpans.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
          surroundingLine = sameLineSpans.map((s) => s.textContent || "").join(" ").replace(/\s+/g, " ").trim();
        }
      }
    }
  } catch {
    // ignore geometry errors
  }

  if (!surroundingLine && range.startContainer.parentElement) {
    surroundingLine = (range.startContainer.parentElement.textContent || rawSelection).replace(/\s+/g, " ").trim();
  }

  const enclosingWord = (prefixAttached || suffixAttached)
    ? cleanSelection(`${prefixAttached}${rawSelection}${suffixAttached}`)
    : undefined;

  return {
    rawSelection,
    prefixAttached,
    suffixAttached,
    surroundingLine,
    enclosingWord
  };
}

function handleSelection(): void {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;

  const range = selection.getRangeAt(0);
  const page = (range.commonAncestorContainer.parentElement ?? range.commonAncestorContainer as Element).closest<HTMLElement>(".page");
  if (!page) return;

  const domDetails = extractDomSelectionDetails(range, page);
  const rawBrowserSelection = domDetails.rawSelection || selection.toString();
  const normalizedSelection = rawBrowserSelection.trim().replace(/\s+/g, " ");

  console.log("RAW BROWSER SELECTION:", rawBrowserSelection);
  console.log("NORMALIZED SELECTION:", normalizedSelection);

  if (!normalizedSelection) return;

  const rect = range.getBoundingClientRect();
  const localText = domDetails.surroundingLine || extractLocalPdfText(page, range, normalizedSelection);
  const candidate = resolveSelectionCandidate(normalizedSelection, domDetails.prefixAttached, domDetails.suffixAttached, localText);

  console.log("[Reader AI Pronunciation]");
  console.log("Raw selection:", domDetails.rawSelection);
  console.log("Resolved term:", candidate.resolvedSelection);
  console.log("Pronunciation target:", candidate.resolvedSelection || normalizedSelection);

  // Reject purely invalid selections (like isolated punctuation with no meaning)
  if (candidate.selectionType === "unknown" && !candidate.resolvedSelection) return;

  const sentence = extractSentence(localText, candidate.resolvedSelection || normalizedSelection);

  showPopup({
    originalSelection: candidate.originalSelection,
    resolvedSelection: candidate.resolvedSelection,
    selectedText: candidate.resolvedSelection || normalizedSelection,
    selectionType: candidate.selectionType,
    sentence,
    context: sentence,
    pageNumber: Number(page.dataset.pageNumber),
    rect
  });
}

function extractLocalPdfText(page: HTMLElement, range: Range, selectedText: string): string {
  const textLayer = page.querySelector<HTMLElement>(".textLayer, .text-layer");
  if (!textLayer) return selectedText;

  const selRect = range.getBoundingClientRect();
  const spans = Array.from(textLayer.querySelectorAll<HTMLElement>("span"));
  const selCenterY = selRect.top + selRect.height / 2;

  const nearbySpans = spans.filter((span) => {
    const sRect = span.getBoundingClientRect();
    if (sRect.width === 0 || sRect.height === 0) return false;
    const sCenterY = sRect.top + sRect.height / 2;
    return Math.abs(sCenterY - selCenterY) < 35;
  });

  if (nearbySpans.length > 0) {
    nearbySpans.sort((a, b) => {
      const rectA = a.getBoundingClientRect();
      const rectB = b.getBoundingClientRect();
      if (Math.abs(rectA.top - rectB.top) > 6) return rectA.top - rectB.top;
      return rectA.left - rectB.left;
    });

    const localJoined = nearbySpans.map((s) => s.textContent || "").join(" ").replace(/\s+/g, " ").trim();
    if (localJoined.toLowerCase().includes(selectedText.toLowerCase())) {
      return localJoined;
    }
  }

  return cleanSelection(textLayer.textContent || selectedText);
}

function prevTextEndsWithSpace(text: string | null): boolean {
  return text ? /\s$/.test(text) : false;
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

  if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
    try {
      chrome.runtime.sendMessage(
        messagePayload,
        (response) => {
          if (chrome.runtime.lastError) {
            console.error("[Reader AI TTS] Runtime error in PDF reader:", chrome.runtime.lastError.message);
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

function renderPronunciationSection(targetWord: string, customIpa?: string, rawSelection?: string): HTMLElement | null {
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

  if (!ipa && !soundsLike) return null;

  const section = document.createElement("div");
  section.className = "pronunciation-section";

  const label = document.createElement("div");
  label.className = "pronunciation-label";
  label.textContent = "PRONUNCIATION";
  section.appendChild(label);

  const audioRow = document.createElement("div");
  audioRow.className = "pronunciation-audio-row";

  const listenBtn = document.createElement("button");
  listenBtn.className = "pronunciation-listen-btn";
  listenBtn.type = "button";
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

  return section;
}

function renderPronunciationRow(targetWord: string, ipaText?: string, rawSelection?: string): HTMLElement | null {
  return renderPronunciationSection(targetWord, ipaText, rawSelection);
}

function showPopup(data: PdfSelectionData): void {
  removePopup();
  popup = document.createElement("section");
  popup.className = "reader-popup";

  const header = document.createElement("div");
  header.className = "popup-header";
  header.innerHTML = `
    <div class="popup-brand">
      <span class="spark">✦</span>
      <span>READER AI</span>
    </div>
    <button type="button" class="close-btn" aria-label="Close">×</button>
  `;
  header.querySelector(".close-btn")?.addEventListener("click", removePopup);
  popup.appendChild(header);

  const body = document.createElement("div");
  body.className = "popup-body";

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
    body.innerHTML = `
      <h2></h2>
      <p style="font-style: italic; font-size: 12px; color: #858279; margin: 2px 0 8px;">You selected: "${data.originalSelection}"</p>
      <div class="label">PAGE ${data.pageNumber} / CONTEXT</div>
      <p class="context-copy"></p>
      <button type="button" class="action-btn"></button>
    `;
    body.querySelector("h2")!.textContent = resolved.toUpperCase();
    if (isEligibleForPronunciation(resolved, data.selectionType)) {
      const row = renderPronunciationRow(resolved, undefined, data.originalSelection);
      if (row) {
        const pageLabel = body.querySelector(".label");
        if (pageLabel) body.insertBefore(row, pageLabel);
      }
    }
    body.querySelector(".context-copy")!.textContent = data.context || data.sentence;
    const button = body.querySelector("button")!;
    button.textContent = `Explain "${resolved}"`;
    button.addEventListener("click", () => requestExplanation(data, popup!));
  } else if (data.selectionType === "partial-word") {
    body.innerHTML = `
      <div class="label">DID YOU MEAN?</div>
      <h2></h2>
      <p style="font-style: italic; font-size: 12px; color: #858279; margin: 2px 0 8px;">You selected: "${data.originalSelection}"</p>
      <div class="label">PAGE ${data.pageNumber} / CONTEXT</div>
      <p class="context-copy"></p>
      <button type="button" class="action-btn"></button>
    `;
    body.querySelector("h2")!.textContent = data.resolvedSelection.toUpperCase();
    if (isEligibleForPronunciation(data.resolvedSelection, data.selectionType)) {
      const row = renderPronunciationRow(data.resolvedSelection, undefined, data.originalSelection);
      if (row) {
        const pageLabel = body.querySelectorAll(".label")[1];
        if (pageLabel) body.insertBefore(row, pageLabel);
      }
    }
    body.querySelector(".context-copy")!.textContent = data.context || data.sentence;
    const button = body.querySelector("button")!;
    button.textContent = `Explain "${data.resolvedSelection}"`;
    button.addEventListener("click", () => requestExplanation(data, popup!));
  } else {
    body.innerHTML = `
      <h2></h2>
      <div class="label">PAGE ${data.pageNumber} / CONTEXT</div>
      <p class="context-copy"></p>
      <button type="button" class="action-btn"></button>
    `;
    body.querySelector("h2")!.textContent = (data.selectionType === "word" ? data.resolvedSelection.toUpperCase() : data.resolvedSelection);
    if (isEligibleForPronunciation(data.resolvedSelection, data.selectionType)) {
      const row = renderPronunciationRow(data.resolvedSelection, undefined, data.originalSelection);
      if (row) {
        const pageLabel = body.querySelector(".label");
        if (pageLabel) body.insertBefore(row, pageLabel);
      }
    } else if (data.selectionType === "word" || data.selectionType === "unknown") {
      const row = renderPronunciationRow(data.resolvedSelection, undefined, data.originalSelection);
      if (row) {
        const pageLabel = body.querySelector(".label");
        if (pageLabel) body.insertBefore(row, pageLabel);
      }
    }
    body.querySelector(".context-copy")!.textContent = data.context || data.sentence;
    const button = body.querySelector("button")!;
    button.textContent = data.selectionType === "passage" ? "Summarize with AI" : "Explain with AI";
    button.addEventListener("click", () => requestExplanation(data, popup!));
  }

  popup.appendChild(body);
  document.body.appendChild(popup);
  positionPopup(popup, data.rect);
}

function requestExplanation(data: PdfSelectionData, popupElement: HTMLElement): void {
  const statusEl = popupElement.querySelector<HTMLElement>(".context-copy") || popupElement.querySelector<HTMLElement>("p");
  if (statusEl) statusEl.textContent = "Analyzing context with Gemini...";

  const body = {
    originalSelection: data.originalSelection,
    resolvedSelection: data.resolvedSelection,
    selectedText: data.resolvedSelection || data.selectedText,
    selectionType: data.selectionType,
    context: data.context || data.sentence,
    sentence: data.sentence,
    paragraph: data.sentence,
    surroundingContext: data.sentence,
    pageTitle: document.title,
    sourceUrl,
    sourceType: "pdf",
    pageNumber: data.pageNumber
  };

  chrome.runtime.sendMessage({ type: "EXPLAIN", payload: body }, (response: { ok: boolean; error?: string; result?: Record<string, unknown> } | undefined) => {
    if (chrome.runtime.lastError || !response?.ok || !response.result) {
      const rawError = response?.error || chrome.runtime.lastError?.message || "";
      const lower = rawError.toLowerCase();
      const isBusy = lower.includes("busy") || lower.includes("demand") || lower.includes("unavailable") || lower.includes("temporarily") || lower.includes("503") || lower.includes("429");
      const errMsg = isBusy ? "AI is temporarily busy. Please try again." : (rawError || "Unable to explain this selection right now.");

      if (statusEl) {
        statusEl.innerHTML = `
          <div class="reader-ai-error-box" style="margin-top: 10px; display: flex; flex-direction: column; gap: 8px;">
            <p style="color: #8b3f35; font-size: 13px; margin: 0;">${errMsg}</p>
            <button type="button" class="action-btn retry-btn" style="align-self: flex-start;">Retry</button>
          </div>
        `;
        const retryBtn = statusEl.querySelector(".retry-btn");
        retryBtn?.addEventListener("click", (e) => {
          e.stopPropagation();
          requestExplanation(data, popupElement);
        });
        positionPopup(popupElement, data.rect);
      }
      return;
    }
    if (statusEl) statusEl.textContent = formatResult(response.result);

    // If word or phrase explanation with pronunciation returned, update/add the pronunciation section
    if (response.result.type === "word" || response.result.type === "phrase") {
      const existingSection = popupElement.querySelector(".pronunciation-section") || popupElement.querySelector(".pronunciation-row");
      const target = String(response.result.word || response.result.phrase || data.resolvedSelection);
      const pron = resolvePronunciation(target, typeof response.result.pronunciation === "string" ? response.result.pronunciation : undefined);
      if (existingSection && pron && pron.ipa && isValidIpa(pron.ipa, pron.resolvedTerm)) {
        let ipaSpan = existingSection.querySelector(".pronunciation-ipa");
        if (!ipaSpan) {
          ipaSpan = document.createElement("span");
          ipaSpan.className = "pronunciation-ipa";
          const audioRow = existingSection.querySelector(".pronunciation-audio-row") || existingSection;
          audioRow.appendChild(ipaSpan);
        }
        ipaSpan.textContent = pron.ipa;
      }
    }

    popupElement.querySelector("button.action-btn")?.remove();
    positionPopup(popupElement, data.rect);
  });
}

function formatResult(result: Record<string, unknown>): string {
  if (result.type === "word") {
    const meaning = result.meaning ? `Meaning:\n${String(result.meaning)}` : "";
    const context = result.contextExplanation ? `\n\nIn this context:\n${String(result.contextExplanation)}` : "";
    const example = result.example ? `\n\nExample:\n"${String(result.example)}"` : "";
    return `${meaning}${context}${example}`.trim();
  }
  if (result.type === "phrase") {
    const meaning = result.meaning ? `Meaning:\n${String(result.meaning)}` : "";
    const context = result.contextExplanation ? `\n\nIn this context:\n${String(result.contextExplanation)}` : "";
    return `${meaning}${context}`.trim();
  }
  const explanation = String(result.simpleExplanation ?? "");
  const points = Array.isArray(result.keyPoints) && result.keyPoints.length > 0 ? `\n\nKey Points:\n• ${result.keyPoints.join("\n• ")}` : "";
  return `${explanation}${points}`.trim();
}

function removePopup(): void {
  stopPronunciation();
  popup?.remove();
  popup = null;
  interactingWithPopup = false;
}

function healText(value: string): string {
  return value
    .replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000]/g, " ")
    .replace(/\u00AD/g, "")
    .replace(/\s+/g, " ")
    .replace(/\b([a-zA-Z]+)\s+(fll?|ffi?|ff)\s+([a-zA-Z]+)\b/gi, (_m, p1, p2, p3) => `${p1}${p2.toLowerCase() === "fll" ? "ffl" : p2}${p3}`)
    .replace(/\b(inter)\s+(view|views|viewed|viewing)\b/gi, "$1$2")
    .replace(/([a-zA-Z0-9]+)\s+(['’`´])\s*([a-zA-Z]+)/g, "$1$2$3")
    .replace(/([a-zA-Z0-9]+)\s*(['’`´])\s+([a-zA-Z]+)/g, "$1$2$3")
    .replace(/([a-zA-Z0-9]+s)\s+(['’`´])(?=\s|$|[.,;:!?])/g, "$1$2")
    .replace(/\s+([,.:;!?])/g, "$1")
    .trim();
}

function normalize(value: string): string { return cleanSelection(value); }

function classify(value: string): "word" | "partial-word" | "phrase" | "sentence" | "passage" {
  const words = value.split(/\s+/).filter(Boolean);
  const count = (value.match(/[.!?](?:\s|$)/g) ?? []).length;
  if (count > 1 || words.length > 40) return "passage";
  if (count === 1 || (words.length >= 6 && /^[A-Z]/.test(value)) || words.length >= 8 || /[.!?]$/.test(value)) {
    return "sentence";
  }
  if (words.length > 1) return "phrase";
  return "word";
}

function extractSentence(text: string, selected: string): string {
  const normalized = normalize(text);
  const cleanSelected = normalize(selected);
  const index = normalized.toLowerCase().indexOf(cleanSelected.toLowerCase());
  if (index < 0) return normalized.slice(0, Math.min(250, normalized.length));

  const before = normalized.slice(0, index);
  const after = normalized.slice(index + cleanSelected.length);

  const previousStop = before.search(/[.!?](?:\s+|$)[^.!?]*$/);
  let start = 0;
  if (previousStop >= 0) {
    const afterPunctuation = before.slice(previousStop + 1);
    const leadingWhitespace = afterPunctuation.match(/^\s+/);
    start = previousStop + 1 + (leadingWhitespace ? leadingWhitespace[0].length : 0);
  } else if (before.length > 160) {
    const windowStart = Math.max(0, before.length - 140);
    const windowText = before.slice(windowStart);
    const spaceIdx = windowText.indexOf(" ");
    start = spaceIdx >= 0 ? windowStart + spaceIdx + 1 : windowStart;
  }

  const nextStop = after.search(/[.!?](?:\s|$)/);
  let end = normalized.length;
  if (nextStop >= 0) {
    end = index + cleanSelected.length + nextStop + 1;
  } else if (after.length > 160) {
    const windowEnd = Math.min(after.length, 140);
    const windowText = after.slice(0, windowEnd);
    const lastSpace = windowText.lastIndexOf(" ");
    end = index + cleanSelected.length + (lastSpace >= 0 ? lastSpace : windowEnd);
  }

  return normalized.slice(start, end).trim();
}

function positionPopup(element: HTMLElement, rect: DOMRect): void {
  // Allow measuring unconstrained natural content height up to MAX_POPUP_HEIGHT
  element.style.maxHeight = `${MAX_POPUP_HEIGHT}px`;

  const box = element.getBoundingClientRect();
  const width = box.width || POPUP_WIDTH;
  const naturalHeight = element.scrollHeight || box.height || 200;

  // Horizontal positioning: center relative to selection, clamped within safe margins
  const center = rect.left + rect.width / 2;
  const targetLeft = center - width / 2;
  const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN);
  const left = Math.max(VIEWPORT_MARGIN, Math.min(targetLeft, maxLeft));

  // Vertical available spaces:
  const spaceBelow = window.innerHeight - rect.bottom - SELECTION_GAP - VIEWPORT_MARGIN;
  const spaceAbove = rect.top - SELECTION_GAP - VIEWPORT_MARGIN;

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
  element.style.maxHeight = `${Math.floor(calculatedMaxHeight)}px`;

  // Calculate top coordinate based on placement direction
  let top: number;
  if (placeBelow) {
    top = rect.bottom + SELECTION_GAP;
  } else {
    const currentHeight = element.getBoundingClientRect().height;
    top = rect.top - SELECTION_GAP - currentHeight;
  }

  // Ensure popup is strictly within viewport bounds [VIEWPORT_MARGIN, window.innerHeight - currentHeight - VIEWPORT_MARGIN]
  const currentHeight = element.getBoundingClientRect().height;
  const clampedTop = Math.max(
    VIEWPORT_MARGIN,
    Math.min(top, Math.max(VIEWPORT_MARGIN, window.innerHeight - currentHeight - VIEWPORT_MARGIN))
  );

  element.style.left = `${Math.round(left)}px`;
  element.style.top = `${Math.round(clampedTop)}px`;
}
