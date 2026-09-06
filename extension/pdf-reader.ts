import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

const viewer = document.querySelector<HTMLElement>("#viewer");
const title = document.querySelector<HTMLElement>("#document-title");
const params = new URLSearchParams(window.location.search);
const sourceUrl = params.get("url");
let popup: HTMLElement | null = null;

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

  await page.render({ canvasContext: canvas.getContext("2d")!, viewport }).promise;
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

document.addEventListener("selectionchange", () => window.setTimeout(() => {
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

function isMeaningfulWord(word: string): boolean {
  if (!word) return false;
  const trimmed = word.trim();
  if (!trimmed) return false;
  if (isTechnicalToken(trimmed)) return true;
  if (/^[^\w\s]+$/.test(trimmed)) return false;
  if (/^[a-zA-Z]$/.test(trimmed)) return trimmed === "a" || trimmed === "A" || trimmed === "I";
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
      if (bestToken && bestOverlap >= 3) {
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
    if (fullWord.toLowerCase() !== targetFragment.toLowerCase() && fullWord.length > targetFragment.length) {
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
        (lowerTarget.length >= 4 && lowerT.includes(lowerTarget))
      );
    });

    if (candidate && candidate.length > targetFragment.length) {
      return { originalSelection: original, resolvedSelection: candidate, selectionType: "partial-word" };
    }
  }

  if (isMeaningfulWord(cleaned)) {
    return { originalSelection: original, resolvedSelection: cleaned, selectionType: "word" };
  }

  return { originalSelection: original, resolvedSelection: cleaned, selectionType: classify(cleaned) };
}

function handleSelection(): void {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;

  const rawBrowserSelection = selection.toString();
  const normalizedSelection = rawBrowserSelection.trim().replace(/\s+/g, " ");

  console.log("RAW BROWSER SELECTION:", rawBrowserSelection);
  console.log("START CONTAINER:", selection.anchorNode);
  console.log("START OFFSET:", selection.anchorOffset);
  console.log("END CONTAINER:", selection.focusNode);
  console.log("END OFFSET:", selection.focusOffset);
  console.log(
    "RANGE TEXT:",
    selection.rangeCount
      ? selection.getRangeAt(0).toString()
      : ""
  );
  console.log("NORMALIZED SELECTION:", normalizedSelection);

  if (!normalizedSelection) return;

  const range = selection.getRangeAt(0);
  const page = (range.commonAncestorContainer.parentElement ?? range.commonAncestorContainer as Element).closest<HTMLElement>(".page");
  if (!page) return;

  const rect = range.getBoundingClientRect();

  // Partial-word boundary detection
  let prefixAttached = "";
  let suffixAttached = "";
  if (range.startContainer.nodeType === Node.TEXT_NODE) {
    const textBefore = (range.startContainer.textContent || "").slice(0, range.startOffset);
    const match = textBefore.match(/[a-zA-Z0-9'’+#.-]+$/);
    if (match) prefixAttached = match[0];
  }
  if (range.endContainer.nodeType === Node.TEXT_NODE) {
    const textAfter = (range.endContainer.textContent || "").slice(range.endOffset);
    const match = textAfter.match(/^[a-zA-Z0-9'’+#.-]+/);
    if (match) suffixAttached = match[0];
  }

  const localText = extractLocalPdfText(page, range, normalizedSelection);
  const candidate = resolveSelectionCandidate(normalizedSelection, prefixAttached, suffixAttached, localText);

  // Reject purely invalid selections (like isolated punctuation with no meaning)
  if (candidate.selectionType === "unknown" || !candidate.resolvedSelection) return;

  const sentence = extractSentence(localText, candidate.resolvedSelection || normalizedSelection);

  showPopup({
    originalSelection: candidate.originalSelection,
    resolvedSelection: candidate.resolvedSelection,
    selectedText: candidate.resolvedSelection,
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
  const pageRect = page.getBoundingClientRect();
  const relTop = selRect.top - pageRect.top;

  const spans = Array.from(textLayer.querySelectorAll<HTMLElement>("span"));
  const nearbySpans = spans.filter((span) => {
    const top = parseFloat(span.style.top) || 0;
    return Math.abs(top - relTop) < 45;
  });

  if (nearbySpans.length > 0) {
    // Sort spans by top then left
    nearbySpans.sort((a, b) => {
      const topA = parseFloat(a.style.top) || 0;
      const topB = parseFloat(b.style.top) || 0;
      if (Math.abs(topA - topB) > 6) return topA - topB;
      const leftA = parseFloat(a.style.left) || 0;
      const leftB = parseFloat(b.style.left) || 0;
      return leftA - leftB;
    });

    let localJoined = "";
    for (let i = 0; i < nearbySpans.length; i++) {
      const curr = nearbySpans[i];
      const currText = curr.textContent || "";
      if (i === 0) {
        localJoined = currText;
      } else {
        const prev = nearbySpans[i - 1];
        const prevLeft = parseFloat(prev.style.left) || 0;
        const prevWidth = prev.getBoundingClientRect().width || 0;
        const currLeft = parseFloat(curr.style.left) || 0;
        const gap = currLeft - (prevLeft + prevWidth);

        if (gap >= 2.5 || prevTextEndsWithSpace(prev.textContent) || currText.startsWith(" ")) {
          localJoined = `${localJoined.trimEnd()} ${currText.trimStart()}`;
        } else {
          localJoined = `${localJoined}${currText}`;
        }
      }
    }

    const cleaned = cleanSelection(localJoined);
    if (cleaned.toLowerCase().includes(selectedText.toLowerCase())) {
      return cleaned;
    }
  }

  return cleanSelection(textLayer.textContent || selectedText);
}

function prevTextEndsWithSpace(text: string | null): boolean {
  return text ? /\s$/.test(text) : false;
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
  body.addEventListener("wheel", (e) => e.stopPropagation());

  if (data.selectionType === "partial-word") {
    body.innerHTML = `
      <div class="label">DID YOU MEAN?</div>
      <h2></h2>
      <p style="font-style: italic; font-size: 12px; color: #858279; margin: 2px 0 8px;">You selected: "${data.originalSelection}"</p>
      <div class="label">PAGE ${data.pageNumber} / CONTEXT</div>
      <p class="context-copy"></p>
      <button type="button" class="action-btn"></button>
    `;
    body.querySelector("h2")!.textContent = data.resolvedSelection.toUpperCase();
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

  chrome.runtime.sendMessage({ type: "EXPLAIN", payload: body }, (response: { ok: boolean; result?: Record<string, unknown> } | undefined) => {
    if (chrome.runtime.lastError || !response?.ok || !response.result) {
      if (statusEl) statusEl.textContent = "Unable to explain this selection right now.";
      return;
    }
    if (statusEl) statusEl.textContent = formatResult(response.result);
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

function removePopup(): void { popup?.remove(); popup = null; }

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
  const box = element.getBoundingClientRect();
  const width = box.width || 320;
  const height = box.height || 220;
  const gutter = 12;
  const gap = 8;

  const center = rect.left + rect.width / 2;
  const targetLeft = center - width / 2;
  const maxLeft = Math.max(gutter, window.innerWidth - width - gutter);
  const left = Math.max(gutter, Math.min(targetLeft, maxLeft));

  const roomBelow = window.innerHeight - rect.bottom;
  const roomAbove = rect.top;
  const neededHeight = height + gap + gutter;

  let top: number;
  if (roomBelow >= neededHeight || roomBelow >= roomAbove) {
    top = rect.bottom + gap;
  } else {
    top = rect.top - height - gap;
  }

  const maxTop = Math.max(gutter, window.innerHeight - height - gutter);
  const clampedTop = Math.max(gutter, Math.min(top, maxTop));

  element.style.left = `${Math.round(left)}px`;
  element.style.top = `${Math.round(clampedTop)}px`;
}
