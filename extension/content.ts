const HOST_ID = "reader-ai-selection-host";
const POPUP_WIDTH = 320;
const VIEWPORT_GUTTER = 12;

let popupHost: HTMLDivElement | null = null;
let popupRoot: ShadowRoot | null = null;
let activePopupElement: HTMLElement | null = null;
let activeRange: Range | null = null;
let interactingWithPopup = false;

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

  // Reconnect detached apostrophes (e.g. "Layla ’ s" -> "Layla’s", "don ' t" -> "don't")
  text = text.replace(/([a-zA-Z0-9]+)\s*['’`´]\s*([a-zA-Z]+)/g, "$1’$2");
  text = text.replace(/([a-zA-Z0-9]+s)\s*['’`´](?=\s|$|[.,;:!?])/g, "$1’");

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
  return result || selected;
}

function analyzeSelection(selection: Selection, range: Range): {
  originalSelection: string;
  resolvedSelection: string;
  selectionType: SelectionData["selectionType"];
} {
  const raw = selection.toString();
  const originalSelection = healText(raw);

  if (!originalSelection || !/[a-zA-Z0-9]/.test(originalSelection)) {
    return {
      originalSelection,
      resolvedSelection: originalSelection,
      selectionType: "unknown"
    };
  }

  // If multiple words
  if (/\s/.test(originalSelection)) {
    const count = (originalSelection.match(/[.!?](?:\s|$)/g) ?? []).length;
    const selectionType = count > 1 ? "passage" : (count === 1 && originalSelection.length > 35) ? "sentence" : "phrase";
    return {
      originalSelection,
      resolvedSelection: originalSelection,
      selectionType
    };
  }

  // Single word: inspect DOM boundaries for partial word selection (e.g. "ello" -> "hello")
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

  if ((prefixAttached || suffixAttached) && /^[a-zA-Z0-9'’-]+$/.test(originalSelection)) {
    const fullWord = healText(`${prefixAttached}${originalSelection}${suffixAttached}`);
    if (fullWord.toLowerCase() !== originalSelection.toLowerCase() && fullWord.length > originalSelection.length) {
      return {
        originalSelection,
        resolvedSelection: fullWord,
        selectionType: "partial-word"
      };
    }
  }

  return {
    originalSelection,
    resolvedSelection: originalSelection,
    selectionType: "word"
  };
}

function removePopup(): void {
  popupHost?.remove();
  popupHost = null;
  popupRoot = null;
  activePopupElement = null;
  activeRange = null;
  interactingWithPopup = false;
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
  addText(body, "Unable to explain this word right now.", "error-title");
  addText(body, errorMsg || "Something went wrong while communicating with Gemini.", "error-copy");
  const tryAgain = document.createElement("button");
  tryAgain.className = "action";
  tryAgain.type = "button";
  tryAgain.textContent = "Try Again";
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
  const renderedRect = popup.getBoundingClientRect();
  const width = renderedRect.width || POPUP_WIDTH;
  const height = renderedRect.height || 200;

  // 1. Center horizontally relative to the selection rectangle
  const selectionCenter = selectionRect.left + selectionRect.width / 2;
  const targetLeft = selectionCenter - width / 2;

  // Clamp horizontally within the viewport edges
  const maxLeft = Math.max(VIEWPORT_GUTTER, window.innerWidth - width - VIEWPORT_GUTTER);
  const popupLeft = Math.max(VIEWPORT_GUTTER, Math.min(targetLeft, maxLeft));

  // 2. Prefer below the selection, place above if insufficient space
  const roomBelow = window.innerHeight - selectionRect.bottom;
  const roomAbove = selectionRect.top;
  const gap = 8;
  const neededHeight = height + gap + VIEWPORT_GUTTER;

  let chosenTop: number;
  if (roomBelow >= neededHeight || roomBelow >= roomAbove) {
    // Sufficient room below or more room below than above
    chosenTop = selectionRect.bottom + gap;
  } else {
    // Flip above
    chosenTop = selectionRect.top - height - gap;
  }

  // Clamp vertically within the viewport edges (never outside viewport)
  const maxTop = Math.max(VIEWPORT_GUTTER, window.innerHeight - height - VIEWPORT_GUTTER);
  const popupTop = Math.max(VIEWPORT_GUTTER, Math.min(chosenTop, maxTop));

  popup.style.left = `${Math.round(popupLeft)}px`;
  popup.style.top = `${Math.round(popupTop)}px`;
}

function updateActivePosition(): void {
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
      width: min(${POPUP_WIDTH}px, calc(100vw - ${VIEWPORT_GUTTER * 2}px));
      max-height: min(70vh, 520px);
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
      flex: 0 0 auto;
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
      overflow-y: auto;
      overscroll-behavior: contain;
      padding: 14px 16px 16px;
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
    .label { margin-top: 14px; color: #858279; font-size: 10px; font-weight: 700; letter-spacing: .16em; }
    .context {
      margin-top: 6px;
      color: #5d5b55;
      font-family: Georgia, serif;
      font-size: 13px;
      line-height: 1.45;
      display: -webkit-box;
      -webkit-line-clamp: 4;
      -webkit-box-orient: vertical;
      overflow: hidden;
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
    @keyframes reader-ai-pulse { 0%, 100% { opacity: .25; transform: scale(.75); } 50% { opacity: 1; transform: scale(1.1); } }
  `;
  popupRoot.appendChild(style);

  const popup = document.createElement("section");
  popup.className = "popup";
  popup.setAttribute("role", "dialog");
  popup.setAttribute("aria-label", "Reader AI context");

  // Prevent clicks inside the popup from bubbling to page or collapsing popup
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

  if (data.selectionType === "partial-word") {
    addText(body, "DID YOU MEAN?", "label");
    addText(body, data.resolvedSelection.toLocaleUpperCase(), "selection");
    addText(body, `You selected: "${data.originalSelection}"`, "part-of-speech");
  } else {
    addText(body, data.resolvedSelection.toLocaleUpperCase(), "selection");
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
  // If the user is actively interacting with the popup, don't re-inspect or remove
  if (interactingWithPopup) return;

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    removePopup();
    return;
  }

  const range = selection.getRangeAt(0);
  const analysis = analyzeSelection(selection, range);

  if (analysis.selectionType === "unknown" || !analysis.originalSelection) {
    removePopup();
    return;
  }

  const rect = range.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) {
    removePopup();
    return;
  }

  const container = getClosestTextContainer(range);
  const selectedParagraph = extractCleanTextFromContainer(container, range.commonAncestorContainer);
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
