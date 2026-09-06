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
  textLayer.className = "text-layer";
  wrapper.appendChild(textLayer);
  viewer?.appendChild(wrapper);

  await page.render({ canvasContext: canvas.getContext("2d")!, viewport }).promise;
  const content = await page.getTextContent();
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

function handleSelection(): void {
  const selection = window.getSelection();
  const rawSelected = selection?.toString() ?? "";
  const selectedText = normalize(rawSelected);
  if (!selection || selection.rangeCount === 0 || !selectedText) return;

  const range = selection.getRangeAt(0);
  const page = (range.commonAncestorContainer.parentElement ?? range.commonAncestorContainer as Element).closest<HTMLElement>(".page");
  if (!page) return;

  const rect = range.getBoundingClientRect();

  // Partial-word boundary detection
  let prefixAttached = "";
  let suffixAttached = "";
  if (range.startContainer.nodeType === Node.TEXT_NODE) {
    const textBefore = (range.startContainer.textContent || "").slice(0, range.startOffset);
    const match = textBefore.match(/[a-zA-Z0-9'’-]+$/);
    if (match) prefixAttached = match[0];
  }
  if (range.endContainer.nodeType === Node.TEXT_NODE) {
    const textAfter = (range.endContainer.textContent || "").slice(range.endOffset);
    const match = textAfter.match(/^[a-zA-Z0-9'’-]+/);
    if (match) suffixAttached = match[0];
  }

  let originalSelection = selectedText;
  let resolvedSelection = selectedText;
  let selectionType: PdfSelectionData["selectionType"] = classify(selectedText);

  if ((prefixAttached || suffixAttached) && !/\s/.test(selectedText) && /^[a-zA-Z0-9'’-]+$/.test(selectedText)) {
    const fullWord = normalize(`${prefixAttached}${selectedText}${suffixAttached}`);
    if (fullWord.toLowerCase() !== selectedText.toLowerCase() && fullWord.length > selectedText.length) {
      resolvedSelection = fullWord;
      selectionType = "partial-word";
    }
  }

  // Find local line(s) around the selection rather than reading the entire page
  const localText = extractLocalPdfText(page, range, resolvedSelection);
  const sentence = extractSentence(localText, resolvedSelection);

  showPopup({
    originalSelection,
    resolvedSelection,
    selectedText: resolvedSelection,
    selectionType,
    sentence,
    context: sentence,
    pageNumber: Number(page.dataset.pageNumber),
    rect
  });
}

function extractLocalPdfText(page: HTMLElement, range: Range, selectedText: string): string {
  const textLayer = page.querySelector<HTMLElement>(".text-layer");
  if (!textLayer) return selectedText;

  const selRect = range.getBoundingClientRect();
  const pageRect = page.getBoundingClientRect();
  const relTop = selRect.top - pageRect.top;

  // Filter spans vertically within ~35px of selection (immediate line + adjacent lines)
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

    const localJoined = nearbySpans.map((s) => s.textContent || "").join(" ");
    const cleaned = normalize(localJoined);
    if (cleaned.toLowerCase().includes(selectedText.toLowerCase())) {
      return cleaned;
    }
  }

  // Fallback: bounded page text
  return normalize(textLayer.textContent || selectedText);
}

function showPopup(data: PdfSelectionData): void {
  removePopup();
  popup = document.createElement("section");
  popup.className = "reader-popup";

  if (data.selectionType === "partial-word") {
    popup.innerHTML = `<div class="label">DID YOU MEAN?</div><h2></h2><p class="partial-note"></p><div class="label">PAGE ${data.pageNumber} / CONTEXT</div><p class="context-copy"></p><button></button>`;
    popup.querySelector("h2")!.textContent = data.resolvedSelection.toUpperCase();
    popup.querySelector(".partial-note")!.textContent = `You selected: "${data.originalSelection}"`;
    popup.querySelector(".context-copy")!.textContent = data.context || data.sentence;
    const button = popup.querySelector("button")!;
    button.textContent = `Explain "${data.resolvedSelection}"`;
    button.addEventListener("click", () => requestExplanation(data, popup!));
  } else {
    popup.innerHTML = `<h2></h2><div class="label">PAGE ${data.pageNumber} / CONTEXT</div><p class="context-copy"></p><button></button>`;
    popup.querySelector("h2")!.textContent = data.resolvedSelection.toUpperCase();
    popup.querySelector(".context-copy")!.textContent = data.context || data.sentence;
    const button = popup.querySelector("button")!;
    button.textContent = data.selectionType === "passage" ? "Summarize with AI" : "Explain with AI";
    button.addEventListener("click", () => requestExplanation(data, popup!));
  }

  document.body.appendChild(popup);
  positionPopup(popup, data.rect);
}

function requestExplanation(data: PdfSelectionData, popupElement: HTMLElement): void {
  const statusEl = popupElement.querySelector<HTMLElement>(".context-copy") || popupElement.querySelector<HTMLElement>("p");
  if (statusEl) statusEl.textContent = "Analyzing context...";

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
    popupElement.querySelector("button")?.remove();
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
    .replace(/([a-zA-Z0-9]+)\s*['’`´]\s*([a-zA-Z]+)/g, "$1’$2")
    .replace(/([a-zA-Z0-9]+s)\s*['’`´](?=\s|$|[.,;:!?])/g, "$1’")
    .replace(/\s+([,.:;!?])/g, "$1")
    .trim();
}

function normalize(value: string): string { return healText(value); }

function classify(value: string): "word" | "partial-word" | "phrase" | "sentence" | "passage" {
  const count = (value.match(/[.!?](?:\s|$)/g) ?? []).length;
  return count > 1 ? "passage" : (count === 1 && (value.length > 30 || /[.!?]$/.test(value))) ? "sentence" : /\s/.test(value) ? "phrase" : "word";
}

function extractSentence(text: string, selected: string): string {
  const normalized = normalize(text);
  const cleanSelected = normalize(selected);
  const index = normalized.toLowerCase().indexOf(cleanSelected.toLowerCase());
  if (index < 0) return normalized.slice(0, Math.min(250, normalized.length));

  const before = normalized.slice(0, index);
  const after = normalized.slice(index + cleanSelected.length);

  const previousStop = before.search(/[.!?](?:\s|$)[^.!?]*$/);
  let start = 0;
  if (previousStop >= 0) {
    start = previousStop + 2;
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
  element.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - box.width - 12))}px`;
  element.style.top = `${Math.max(12, Math.min(innerHeight - box.height - 12, innerHeight - rect.bottom > box.height ? rect.bottom + 10 : rect.top - box.height - 10))}px`;
}
