"use client";

import { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import { buildReadingContext, healExtractedText, cleanSelection, resolveSelectionCandidate, extractDomSelectionDetails, type ReadingContext } from "../../lib/reading-context";
import {
  resolvePronunciation,
  isCamelCase,
  splitCamelCase,
  isEligibleForPronunciation,
  normalizeSpokenText,
  isValidIpa
} from "../../lib/pronunciation";

// The worker is emitted by Next's client bundle, so the PDF bytes remain local.
pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

type PageModel = {
  pageNumber: number;
  width: number;
  height: number;
  text: string;
  lines: string[];
  items: TextItemModel[];
  imageData: string;
  textContentSource: ConstructorParameters<typeof pdfjsLib.TextLayer>[0]["textContentSource"];
  viewport: ConstructorParameters<typeof pdfjsLib.TextLayer>[0]["viewport"];
};

type TextItemModel = {
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
};

type Explanation = Record<string, unknown>;

type PopupState = {
  context: ReadingContext;
  left: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
  rect: DOMRect;
};

function playPronunciation(
  targetWord: string,
  ipaText?: string,
  onStateChange?: (isSpeaking: boolean) => void
) {
  console.log("[Reader AI TTS] Listen clicked");

  if (!targetWord || !isEligibleForPronunciation(targetWord)) {
    console.warn("[Reader AI TTS] Error: Target ineligible for pronunciation:", targetWord);
    onStateChange?.(false);
    return;
  }

  const pronData = resolvePronunciation(targetWord, ipaText);
  const ttsText = pronData?.spokenText || normalizeSpokenText(targetWord);

  console.log("[Reader AI Pronunciation]");
  console.log("Raw selection:", targetWord);
  console.log("Resolved term:", pronData?.resolvedTerm || targetWord);
  console.log("Pronunciation target:", targetWord);
  console.log("IPA:", pronData?.ipa || "none");
  console.log("TTS text:", ttsText);

  // Check if running within Chrome extension origin (chrome-extension://)
  const isExtensionOrigin = typeof window !== "undefined" && window.location.protocol === "chrome-extension:";

  if (isExtensionOrigin && typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
    console.log("[Reader AI TTS] Message sent");
    onStateChange?.(true);
    chrome.runtime.sendMessage(
      {
        type: "SPEAK_PRONUNCIATION",
        text: ttsText,
        lang: "en-US"
      },
      (response) => {
        if (chrome.runtime.lastError || !response || response.success === false) {
          console.warn("[Reader AI TTS] Extension TTS failed, using fallback SpeechSynthesis:", chrome.runtime.lastError?.message || response?.error);
          fallbackSpeechSynthesis(ttsText, onStateChange);
        }
      }
    );
    return;
  }

  fallbackSpeechSynthesis(ttsText, onStateChange);
}

function fallbackSpeechSynthesis(spokenText: string, onStateChange?: (isSpeaking: boolean) => void) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    console.error("[Reader AI TTS] Error: SpeechSynthesis is not supported");
    onStateChange?.(false);
    return;
  }

  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(spokenText);
    utterance.lang = "en-US";
    utterance.rate = 0.8;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;

    // Prevent GC in Chromium/Chrome
    (window as unknown as { __readerAiActiveUtterance?: SpeechSynthesisUtterance | null }).__readerAiActiveUtterance = utterance;

    utterance.onstart = () => {
      console.log("[Reader AI TTS] Event: start");
      onStateChange?.(true);
    };
    utterance.onend = () => {
      console.log("[Reader AI TTS] Event: end");
      (window as unknown as { __readerAiActiveUtterance?: SpeechSynthesisUtterance | null }).__readerAiActiveUtterance = null;
      onStateChange?.(false);
    };
    utterance.onerror = (e) => {
      console.error("[Reader AI TTS] Error: SpeechSynthesis error:", e);
      (window as unknown as { __readerAiActiveUtterance?: SpeechSynthesisUtterance | null }).__readerAiActiveUtterance = null;
      onStateChange?.(false);
    };

    window.speechSynthesis.speak(utterance);
    if (window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
    }
  } catch (e) {
    console.error("[Reader AI TTS] Error: SpeechSynthesis execution error:", e);
    onStateChange?.(false);
  }
}

function stopPronunciation() {
  if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
    try {
      chrome.runtime.sendMessage({ type: "STOP_TTS" });
    } catch {
      // ignore
    }
  }
  if (typeof window !== "undefined") {
    window.postMessage({ type: "READER_AI_TTS_STOP" }, "*");
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  }
}

function PronunciationRow({
  targetWord,
  ipaText
}: {
  targetWord: string;
  ipaText?: string;
}) {
  const [isSpeaking, setIsSpeaking] = useState(false);

  // Safety timeout: Never stay stuck in speaking state forever
  useEffect(() => {
    if (!isSpeaking) return;
    const timer = window.setTimeout(() => {
      console.warn("[Reader AI TTS] Safety timeout reached, resetting state to idle");
      setIsSpeaking(false);
    }, 7000);
    return () => window.clearTimeout(timer);
  }, [isSpeaking]);

  if (!targetWord || !isEligibleForPronunciation(targetWord)) {
    return (
      <div className="pronunciation-hint" style={{ fontSize: "11px", color: "#858279", fontStyle: "italic", margin: "6px 0 2px" }}>
        Select a complete word to hear pronunciation.
      </div>
    );
  }

  const pron = resolvePronunciation(targetWord, ipaText);
  if (!pron) {
    return (
      <div className="pronunciation-hint" style={{ fontSize: "11px", color: "#858279", fontStyle: "italic", margin: "6px 0 2px" }}>
        Select a complete word to hear pronunciation.
      </div>
    );
  }
  const ipa = pron.ipa;
  const soundsLike = pron.phonetic;

  if (!ipa && !soundsLike) {
    return (
      <div className="pronunciation-hint" style={{ fontSize: "11px", color: "#858279", fontStyle: "italic", margin: "6px 0 2px" }}>
        Select a complete word to hear pronunciation.
      </div>
    );
  }

  const handleSpeakerClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isSpeaking) {
      stopPronunciation();
      setIsSpeaking(false);
    } else {
      setIsSpeaking(true);
      playPronunciation(pron.spokenText || pron.resolvedTerm, ipa, (speaking) => {
        setIsSpeaking(speaking);
      });
    }
  };

  return (
    <div className="pronunciation-section">
      <div className="pronunciation-label">PRONUNCIATION</div>
      <div className="pronunciation-audio-row">
        <button
          type="button"
          className={`pronunciation-listen-btn ${isSpeaking ? "speaking" : ""}`}
          aria-label={isSpeaking ? "Stop pronunciation" : "Listen to pronunciation"}
          onClick={handleSpeakerClick}
        >
          <span className="btn-icon">
            {isSpeaking ? (
              <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor">
                <rect x="5" y="5" width="14" height="14" rx="2" ry="2" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
                <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
              </svg>
            )}
          </span>
          <span className="btn-text">{isSpeaking ? "Stop" : "Listen"}</span>
        </button>
        {ipa && isValidIpa(ipa, pron.resolvedTerm) && (
          <span className="pronunciation-ipa">
            {ipa}
          </span>
        )}
      </div>
      {soundsLike && (
        <div className="pronunciation-sounds-like">
          Sounds like: <span className="phonetic-text">{soundsLike}</span>
        </div>
      )}
    </div>
  );
}

export default function PdfReader() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pages, setPages] = useState<PageModel[]>([]);
  const [fileName, setFileName] = useState("");
  const [status, setStatus] = useState("Choose a text-based PDF to begin reading.");
  const [activePage, setActivePage] = useState(1);
  const [popup, setPopup] = useState<PopupState | null>(null);
  const [explanation, setExplanation] = useState<Explanation | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    try {
      const saved = localStorage.getItem("reader_theme");
      if (saved === "light" || saved === "dark") {
        setTheme(saved);
      } else if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
        setTheme("dark");
      }
    } catch {
      // ignore
    }
  }, []);

  const handleThemeChange = (newTheme: "light" | "dark") => {
    setTheme(newTheme);
    try {
      localStorage.setItem("reader_theme", newTheme);
    } catch { }
    if (typeof window !== "undefined" && (window as unknown as { chrome?: { storage?: { local?: { set: (data: Record<string, unknown>) => void } } } }).chrome?.storage?.local) {
      (window as unknown as { chrome: { storage: { local: { set: (data: Record<string, unknown>) => void } } } }).chrome.storage.local.set({ reader_theme: newTheme });
    }
  };

  useEffect(() => {
    document.documentElement.setAttribute("data-reader-ai", "true");
    (window as unknown as { __READER_AI_NATIVE__?: boolean }).__READER_AI_NATIVE__ = true;
    const handleScroll = () => {
      const page = document.elementFromPoint(window.innerWidth / 2, 180)?.closest<HTMLElement>("[data-page-number]");
      if (page?.dataset.pageNumber) setActivePage(Number(page.dataset.pageNumber));
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      document.documentElement.removeAttribute("data-reader-ai");
      delete (window as unknown as { __READER_AI_NATIVE__?: boolean }).__READER_AI_NATIVE__;
      window.removeEventListener("scroll", handleScroll);
    };
  }, []);

  async function openPdf(file: File) {
    setStatus("Reading PDF locally...");
    setError("");
    setPopup(null);
    setExplanation(null);
    setFileName(file.name);
    try {
      const bytes = await file.arrayBuffer();
      const documentProxy = await pdfjsLib.getDocument({ data: bytes }).promise;
      const loadedPages: PageModel[] = [];
      for (let pageNumber = 1; pageNumber <= documentProxy.numPages; pageNumber += 1) {
        const page = await documentProxy.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1.25 });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const canvasContext = canvas.getContext("2d");
        if (!canvasContext) throw new Error("Canvas rendering is unavailable.");
        await page.render({ canvas: canvas, canvasContext, viewport }).promise;
        const textContent = await page.getTextContent();
        const items = textContent.items.flatMap((item) => {
          if (!("str" in item) || !item.str) return [];
          const transform = pdfjsLib.Util.transform(viewport.transform, item.transform);
          return [{
            text: item.str,
            left: transform[4],
            top: transform[5] - item.height * 1.25,
            width: item.width * 1.25,
            height: item.height * 1.25
          }];
        });
        const lines = createTextLines(items);
        loadedPages.push({
          pageNumber,
          width: viewport.width,
          height: viewport.height,
          text: lines.join(" "),
          lines,
          items,
          imageData: canvas.toDataURL("image/png"),
          textContentSource: textContent,
          viewport
        });
      }
      setPages(loadedPages);
      setActivePage(1);
      setStatus(`${loadedPages.length} pages ready for reading.`);
    } catch (readError) {
      console.error("Reader AI PDF load failed", readError);
      setPages([]);
      setStatus("Unable to read this PDF.");
      setError("This reader supports text-based PDFs. Scanned PDFs will need OCR in a later phase.");
    }
  }

  function handleSelection(page: PageModel, event: React.MouseEvent<HTMLElement>) {
    window.setTimeout(() => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;

      const range = selection.getRangeAt(0);
      const domDetails = extractDomSelectionDetails(range);
      const rawBrowserSelection = domDetails.rawSelection || selection.toString();
      const normalizedSelection = rawBrowserSelection.trim().replace(/\s+/g, " ");

      console.log("RAW BROWSER SELECTION:", rawBrowserSelection);
      console.log("START CONTAINER:", selection.anchorNode);
      console.log("START OFFSET:", selection.anchorOffset);
      console.log("END CONTAINER:", selection.focusNode);
      console.log("END OFFSET:", selection.focusOffset);
      console.log(
        "RANGE TEXT:",
        range.toString()
      );
      console.log("NORMALIZED SELECTION:", normalizedSelection);

      if (!normalizedSelection) return;

      const rect = range.getBoundingClientRect();

      const surroundingLine = domDetails.surroundingLine ||
        page.lines.find((l) => l.toLowerCase().includes(normalizedSelection.toLowerCase())) ||
        findLocalParagraph(page, normalizedSelection);

      const analysis = resolveSelectionCandidate(
        normalizedSelection,
        domDetails.prefixAttached,
        domDetails.suffixAttached,
        surroundingLine
      );

      console.log("[Reader AI Pronunciation]");
      console.log("Raw selection:", domDetails.rawSelection);
      console.log("Resolved term:", analysis.resolvedSelection);
      console.log("Pronunciation target:", analysis.resolvedSelection || normalizedSelection);

      if (analysis.selectionType === "unknown" && !analysis.resolvedSelection && !analysis.originalSelection) {
        return;
      }

      const termToUse = analysis.resolvedSelection || analysis.originalSelection;
      const localParagraph = domDetails.surroundingLine || findLocalParagraph(page, termToUse);

      const context = buildReadingContext({
        selectedText: termToUse,
        originalSelection: analysis.originalSelection,
        resolvedSelection: analysis.resolvedSelection,
        selectionType: analysis.selectionType,
        paragraph: localParagraph,
        pageTitle: fileName,
        sourceType: "pdf",
        pageNumber: page.pageNumber
      });

      const position = computePopupPosition(rect, 240, 320);

      setPopup({
        context,
        left: position.left,
        top: position.top,
        bottom: position.bottom,
        maxHeight: position.maxHeight,
        rect
      });
      setExplanation(null);
      setError("");
    }, 0);
    event.stopPropagation();
  }

  async function explain() {
    if (!popup) return;
    try {
      setError("");
      setLoading(true);
      const payload = {
        originalSelection: popup.context.originalSelection,
        resolvedSelection: popup.context.resolvedSelection,
        selectedText: popup.context.resolvedSelection || popup.context.selectedText,
        selectionType: popup.context.selectionType,
        context: popup.context.context,
        sentence: popup.context.sentence,
        paragraph: popup.context.paragraph,
        surroundingContext: popup.context.surroundingContext,
        pageTitle: popup.context.pageTitle,
        sourceType: "pdf",
        pageNumber: popup.context.pageNumber
      };
      const response = await fetch("/api/explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const result = await response.json() as (Explanation & { error?: string; success?: boolean; retryable?: boolean });
      if (!response.ok || (result && (result as { success?: boolean }).success === false)) {
        const errorMsg = result?.error || (response.status === 503 || response.status === 429
          ? "AI is temporarily busy. Please try again."
          : "Unable to explain this selection right now.");
        throw new Error(errorMsg);
      }
      setExplanation(result);
      setPopup((prev) => {
        if (!prev) return null;
        const pos = computePopupPosition(prev.rect, 480, 320);
        return {
          ...prev,
          left: pos.left,
          top: pos.top,
          bottom: pos.bottom,
          maxHeight: pos.maxHeight
        };
      });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "AI is temporarily busy. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main
      className="pdf-reader-shell"
      data-reader-ai="true"
      data-theme={theme}
      onMouseDown={(event) => {
        if (!(event.target as HTMLElement).closest(".reader-ai-popup")) {
          stopPronunciation();
          setPopup(null);
        }
      }}
    >
      <header className="pdf-reader-header">
        <div className="pdf-brand"><span>✦</span> READER AI</div>
        <div className="pdf-actions">
          <div className="theme-segmented-control" role="radiogroup" aria-label="Reading theme">
            <button
              type="button"
              className={`theme-option ${theme === "light" ? "active" : ""}`}
              data-theme="light"
              role="radio"
              aria-checked={theme === "light"}
              title="Switch to Light Theme"
              onClick={() => handleThemeChange("light")}
            >
              <svg className="theme-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="5" />
                <line x1="12" y1="1" x2="12" y2="3" />
                <line x1="12" y1="21" x2="12" y2="23" />
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                <line x1="1" y1="12" x2="3" y2="12" />
                <line x1="21" y1="12" x2="23" y2="12" />
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
              </svg>
              <span>Light</span>
            </button>
            <button
              type="button"
              className={`theme-option ${theme === "dark" ? "active" : ""}`}
              data-theme="dark"
              role="radio"
              aria-checked={theme === "dark"}
              title="Switch to Dark Theme"
              onClick={() => handleThemeChange("dark")}
            >
              <svg className="theme-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
              <span>Dark</span>
            </button>
          </div>
          <span className="pdf-file-name">{fileName || "LOCAL PDF READER"}</span>
          <button type="button" className="open-pdf-button" onClick={() => inputRef.current?.click()}>Open PDF</button>
          <input ref={inputRef} type="file" accept="application/pdf,.pdf" hidden onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void openPdf(file);
          }} />
        </div>
      </header>

      <section className="pdf-reading-stage">
        {pages.length === 0 ? (
          <div className="pdf-empty-state"><span className="empty-mark">✦</span><h1>Bring a book into focus.</h1><p>{status}</p><button type="button" className="open-pdf-button large" onClick={() => inputRef.current?.click()}>Open PDF</button>{error && <p className="pdf-error">{error}</p>}</div>
        ) : pages.map((page) => (
          <PdfPageView key={page.pageNumber} page={page} onSelection={handleSelection} />
        ))}
      </section>

      <footer className="pdf-reader-footer"><span>{pages.length ? `Page ${activePage} / ${pages.length}` : "Text-based PDFs processed locally"}</span><span>{status}</span></footer>

      {popup && (
        <section
          className="reader-ai-popup"
          style={{
            left: `${popup.left}px`,
            top: popup.top !== undefined ? `${popup.top}px` : undefined,
            bottom: popup.bottom !== undefined ? `${popup.bottom}px` : undefined,
            maxHeight: `${popup.maxHeight}px`
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="reader-popup-header">
            <div className="brand-label">
              <span className="spark">✦</span>
              <span>READER AI</span>
            </div>
            <button
              type="button"
              className="close-btn"
              aria-label="Close"
              onClick={() => {
                stopPronunciation();
                setPopup(null);
              }}
            >
              ×
            </button>
          </div>
          <div className="reader-popup-body">
            {!explanation && !loading && (
              <>
                {isCamelCase(popup.context.originalSelection || "") ? (
                  <>
                    <h2>{splitCamelCase(popup.context.originalSelection || "").toUpperCase()}</h2>
                    <p style={{ fontStyle: "italic", fontSize: "12px", color: "#858279", margin: "2px 0 8px" }}>
                      You selected: &ldquo;{popup.context.originalSelection}&rdquo;
                    </p>
                    {isEligibleForPronunciation(splitCamelCase(popup.context.originalSelection || ""), popup.context.selectionType) && (
                      <PronunciationRow targetWord={splitCamelCase(popup.context.originalSelection || "")} />
                    )}
                  </>
                ) : popup.context.selectionType === "partial-word" ? (
                  <>
                    <div className="popup-label">DID YOU MEAN?</div>
                    <h2>{popup.context.resolvedSelection?.toUpperCase()}</h2>
                    <p style={{ fontStyle: "italic", fontSize: "12px", color: "#858279", margin: "2px 0 8px" }}>
                      You selected: &ldquo;{popup.context.originalSelection}&rdquo;
                    </p>
                    {isEligibleForPronunciation(popup.context.resolvedSelection || "", popup.context.selectionType) && (
                      <PronunciationRow targetWord={popup.context.resolvedSelection || ""} />
                    )}
                  </>
                ) : (
                  <>
                    <h2>{(popup.context.selectionType === "word" ? popup.context.resolvedSelection?.toUpperCase() : popup.context.selectedText) || popup.context.selectedText}</h2>
                    {isEligibleForPronunciation(popup.context.resolvedSelection || popup.context.selectedText, popup.context.selectionType) && (
                      <PronunciationRow targetWord={popup.context.resolvedSelection || popup.context.selectedText} />
                    )}
                  </>
                )}
                <div className="popup-label">CONTEXT</div>
                <p>{popup.context.context || popup.context.sentence}</p>
                <button type="button" className="explain-button" onClick={() => void explain()}>
                  {popup.context.selectionType === "partial-word"
                    ? `Explain "${popup.context.resolvedSelection}"`
                    : popup.context.selectionType === "passage"
                      ? "Summarize with AI"
                      : "Explain with AI"}
                </button>
              </>
            )}
            {loading && (
              <>
                <h2>{popup.context.selectedText.toUpperCase()}</h2>
                <p className="analyzing">Analyzing context with Gemini...</p>
              </>
            )}
            {explanation && (
              <ExplanationView
                explanation={explanation}
                resolvedWord={popup.context.resolvedSelection || popup.context.selectedText}
              />
            )}
            {error && !loading && (
              <div className="reader-ai-error-box">
                <p className="pdf-error">{error}</p>
                <button
                  type="button"
                  className="explain-button retry-button"
                  onClick={() => void explain()}
                >
                  Retry
                </button>
              </div>
            )}
          </div>
        </section>
      )}
    </main>
  );
}

function computePopupPosition(rect: DOMRect, estimatedHeight = 240, popupWidth = 320): { left: number; top?: number; bottom?: number; maxHeight: number } {
  const gutter = 16;
  const gap = 8;
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;

  const center = rect.left + rect.width / 2;
  const targetLeft = center - popupWidth / 2;
  const maxLeft = Math.max(gutter, viewportW - popupWidth - gutter);
  const left = Math.max(gutter, Math.min(targetLeft, maxLeft));

  const spaceBelow = viewportH - rect.bottom - gap - gutter;
  const spaceAbove = rect.top - gap - gutter;
  const maxAllowedHeight = Math.max(160, viewportH - 32);

  let placeBelow: boolean;
  let availableSpace: number;

  if (spaceBelow >= Math.min(estimatedHeight, 380)) {
    placeBelow = true;
    availableSpace = spaceBelow;
  } else if (spaceAbove >= Math.min(estimatedHeight, 380)) {
    placeBelow = false;
    availableSpace = spaceAbove;
  } else {
    if (spaceBelow >= spaceAbove) {
      placeBelow = true;
      availableSpace = spaceBelow;
    } else {
      placeBelow = false;
      availableSpace = spaceAbove;
    }
  }

  const maxHeight = Math.max(140, Math.min(availableSpace, maxAllowedHeight));

  if (placeBelow) {
    return {
      left: Math.round(left),
      top: Math.round(rect.bottom + gap),
      maxHeight: Math.round(maxHeight)
    };
  } else {
    return {
      left: Math.round(left),
      bottom: Math.round(viewportH - rect.top + gap),
      maxHeight: Math.round(maxHeight)
    };
  }
}

function createTextLines(items: TextItemModel[]): string[] {
  // Group items by line top coordinate
  const lineGroups: Array<{ top: number; items: TextItemModel[] }> = [];
  for (const item of items) {
    const group = lineGroups.find((g) => Math.abs(g.top - item.top) < item.height * 0.6);
    if (group) group.items.push(item);
    else lineGroups.push({ top: item.top, items: [item] });
  }

  // Sort lines vertically from top to bottom
  lineGroups.sort((a, b) => a.top - b.top);

  // For each line, sort items horizontally by left position
  const lines: string[] = [];
  for (const group of lineGroups) {
    group.items.sort((a, b) => a.left - b.left);
    let lineStr = "";
    for (let i = 0; i < group.items.length; i++) {
      const curr = group.items[i];
      if (i === 0) {
        lineStr = curr.text;
      } else {
        const prev = group.items[i - 1];
        const gap = curr.left - (prev.left + prev.width);
        if (gap >= 2.5 || prev.text.endsWith(" ") || curr.text.startsWith(" ")) {
          lineStr = `${lineStr.trimEnd()} ${curr.text.trimStart()}`;
        } else {
          lineStr = `${lineStr}${curr.text}`;
        }
      }
    }
    const healed = healExtractedText(lineStr);
    if (healed) lines.push(healed);
  }

  return lines;
}

function findLocalParagraph(page: PageModel, selectedText: string): string {
  const normalizedSelection = selectedText.toLocaleLowerCase();
  const lineIndex = page.lines.findIndex((line) => line.toLocaleLowerCase().includes(normalizedSelection));
  if (lineIndex < 0) {
    for (let i = 0; i < page.lines.length - 1; i++) {
      const combined = `${page.lines[i]} ${page.lines[i + 1]}`.toLocaleLowerCase();
      if (combined.includes(normalizedSelection)) {
        return `${page.lines[i]} ${page.lines[i + 1]}`;
      }
    }
    return selectedText;
  }
  const start = Math.max(0, lineIndex - 1);
  const end = Math.min(page.lines.length, lineIndex + 2);
  return page.lines.slice(start, end).join(" ");
}

function ExplanationView({
  explanation,
  resolvedWord
}: {
  explanation: Explanation;
  resolvedWord: string;
}) {
  const type = explanation.type;

  if (type === "word") {
    const word = String(explanation.word ?? resolvedWord ?? "");
    const ipa = typeof explanation.pronunciation === "string" ? explanation.pronunciation : undefined;

    return (
      <div className="explanation-view">
        <h2>{word.toUpperCase()}</h2>
        {Boolean(explanation.partOfSpeech) && (
          <div style={{ fontSize: "11px", fontStyle: "italic", color: "#858279", margin: "2px 0 6px" }}>
            {String(explanation.partOfSpeech)}
          </div>
        )}
        <PronunciationRow targetWord={word} ipaText={ipa} />
        <div className="popup-label">MEANING</div>
        <p>{String(explanation.meaning ?? explanation.simpleMeaning ?? "")}</p>
        <div className="popup-label">IN THIS CONTEXT</div>
        <p>{String(explanation.contextExplanation ?? explanation.meaning ?? "")}</p>
        {Boolean(explanation.example) && (
          <>
            <div className="popup-label">EXAMPLE</div>
            <p style={{ fontStyle: "italic" }}>{String(explanation.example)}</p>
          </>
        )}
        {Array.isArray(explanation.keyPoints) && explanation.keyPoints.length > 0 && (
          <>
            <div className="popup-label">KEY POINTS</div>
            <ul>
              {explanation.keyPoints.map((point) => (
                <li key={String(point)}>{String(point)}</li>
              ))}
            </ul>
          </>
        )}
      </div>
    );
  }

  if (type === "phrase") {
    const phrase = String(explanation.phrase ?? resolvedWord ?? "");
    const ipa = typeof explanation.pronunciation === "string" ? explanation.pronunciation : undefined;

    return (
      <div className="explanation-view">
        <h2>{phrase.toUpperCase()}</h2>
        <PronunciationRow targetWord={phrase} ipaText={ipa} />
        <div className="popup-label">MEANING</div>
        <p>{String(explanation.meaning ?? "")}</p>
        <div className="popup-label">IN THIS CONTEXT</div>
        <p>{String(explanation.contextExplanation ?? "")}</p>
        {Boolean(explanation.simpleExplanation) && (
          <>
            <div className="popup-label">SIMPLE EXPLANATION</div>
            <p>{String(explanation.simpleExplanation)}</p>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="explanation-view">
      <h2>{String(explanation.selectedText ?? resolvedWord ?? "")}</h2>
      <div className="popup-label">SENTENCE EXPLANATION</div>
      <p>{String(explanation.simpleExplanation ?? "")}</p>
      {Array.isArray(explanation.keyPoints) && explanation.keyPoints.length > 0 && (
        <>
          <div className="popup-label">KEY POINTS</div>
          <ul>
            {explanation.keyPoints.map((point) => (
              <li key={String(point)}>{String(point)}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function PdfPageView({
  page,
  onSelection
}: {
  page: PageModel;
  onSelection: (page: PageModel, event: React.MouseEvent<HTMLElement>) => void;
}) {
  const textLayerRef = useRef<HTMLDivElement>(null);
  const renderedRef = useRef(false);

  useEffect(() => {
    if (!textLayerRef.current || !page.textContentSource || !page.viewport || renderedRef.current) return;
    renderedRef.current = true;
    textLayerRef.current.replaceChildren();
    textLayerRef.current.style.setProperty("--total-scale-factor", String(page.viewport.scale));
    try {
      const textLayerObj = new pdfjsLib.TextLayer({
        textContentSource: page.textContentSource,
        container: textLayerRef.current,
        viewport: page.viewport
      });
      void textLayerObj.render();
    } catch (e) {
      console.error("TextLayer render failed", e);
    }
  }, [page]);

  return (
    <article
      className="pdf-page"
      data-page-number={page.pageNumber}
      style={{ width: page.width, height: page.height }}
      onMouseUp={(event) => onSelection(page, event)}
    >
      <img className="pdf-page-image" src={page.imageData} alt={`Page ${page.pageNumber}`} />
      <div
        ref={textLayerRef}
        className="textLayer"
        style={{ width: page.width, height: page.height }}
      />
    </article>
  );
}
