"use client";

import { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import { buildReadingContext, healExtractedText, analyzeSelectionBoundaries, type ReadingContext } from "../../lib/reading-context";

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
  top: number;
};

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

  useEffect(() => {
    const handleScroll = () => {
      const page = document.elementFromPoint(window.innerWidth / 2, 180)?.closest<HTMLElement>("[data-page-number]");
      if (page?.dataset.pageNumber) setActivePage(Number(page.dataset.pageNumber));
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
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
          imageData: canvas.toDataURL("image/png")
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
      const rawSelected = selection?.toString() ?? "";
      const selectedText = healExtractedText(rawSelected);
      if (!selection || selection.rangeCount === 0 || !selectedText) return;

      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();

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

      const analysis = analyzeSelectionBoundaries(selectedText, prefixAttached, suffixAttached);
      const termToUse = analysis.resolvedSelection || selectedText;
      const localParagraph = findLocalParagraph(page, termToUse);

      const context = buildReadingContext({
        selectedText: termToUse,
        originalSelection: analysis.originalSelection,
        resolvedSelection: termToUse,
        selectionType: analysis.selectionType,
        paragraph: localParagraph,
        pageTitle: fileName,
        sourceType: "pdf",
        pageNumber: page.pageNumber
      });

      setPopup({
        context,
        left: Math.max(16, Math.min(rect.left, window.innerWidth - 336)),
        top: Math.max(16, Math.min(rect.bottom + 12, window.innerHeight - 220))
      });
      setExplanation(null);
      setError("");
    }, 0);
    event.stopPropagation();
  }

  async function explain() {
    if (!popup) return;
    setLoading(true);
    setError("");
    try {
      const payload = {
        originalSelection: popup.context.originalSelection,
        resolvedSelection: popup.context.resolvedSelection,
        selectedText: popup.context.selectedText,
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
      const result = await response.json() as Explanation & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Unable to explain this selection.");
      setExplanation(result);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to explain this selection.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="pdf-reader-shell" onMouseDown={(event) => {
      if (!(event.target as HTMLElement).closest(".reader-ai-popup")) setPopup(null);
    }}>
      <header className="pdf-reader-header">
        <div className="pdf-brand"><span>✦</span> READER AI</div>
        <div className="pdf-actions">
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
          <article key={page.pageNumber} className="pdf-page" data-page-number={page.pageNumber} style={{ width: page.width, height: page.height }} onMouseUp={(event) => handleSelection(page, event)}>
            <img className="pdf-page-image" src={page.imageData} alt={`Page ${page.pageNumber}`} />
            <div className="pdf-text-layer">{page.items.map((item, index) => <span key={`${page.pageNumber}-${index}`} style={{ left: item.left, top: item.top, width: item.width, height: item.height, fontSize: item.height }}>{item.text}</span>)}</div>
          </article>
        ))}
      </section>

      <footer className="pdf-reader-footer"><span>{pages.length ? `Page ${activePage} / ${pages.length}` : "Text-based PDFs processed locally"}</span><span>{status}</span></footer>

      {popup && <section className="reader-ai-popup" style={{ left: popup.left, top: popup.top }} onMouseDown={(event) => event.stopPropagation()}>
        <div className="reader-popup-heading"><span>✦ READER AI</span><button type="button" aria-label="Close" onClick={() => setPopup(null)}>×</button></div>
        {!explanation && !loading && <>
          {popup.context.selectionType === "partial-word" ? (
            <>
              <div className="popup-label">DID YOU MEAN?</div>
              <h2>{popup.context.resolvedSelection?.toUpperCase()}</h2>
              <p style={{ fontStyle: "italic", fontSize: "12px", color: "#858279", margin: "2px 0 8px" }}>You selected: &ldquo;{popup.context.originalSelection}&rdquo;</p>
            </>
          ) : (
            <h2>{popup.context.selectedText}</h2>
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
        </>}
        {loading && <><h2>{popup.context.selectedText}</h2><p className="analyzing">Analyzing context...</p></>}
        {explanation && <ExplanationView explanation={explanation} />}
        {error && <p className="pdf-error">{error}</p>}
      </section>}
    </main>
  );
}

function createTextLines(items: TextItemModel[]): string[] {
  const lines: Array<{ top: number; text: string }> = [];
  for (const item of items) {
    const line = lines.find((candidate) => Math.abs(candidate.top - item.top) < item.height * 0.6);
    if (line) line.text = `${line.text} ${item.text}`;
    else lines.push({ top: item.top, text: item.text });
  }
  return lines.sort((left, right) => left.top - right.top).map((line) => healExtractedText(line.text)).filter(Boolean);
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

function ExplanationView({ explanation }: { explanation: Explanation }) {
  const type = explanation.type;

  if (type === "word") {
    return (
      <div className="explanation-view">
        <h2>{String(explanation.word ?? "").toUpperCase()}</h2>
        {Boolean(explanation.partOfSpeech) && <div style={{ fontSize: "11px", fontStyle: "italic", color: "#858279", margin: "2px 0 6px" }}>{String(explanation.partOfSpeech)}</div>}
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
      </div>
    );
  }

  if (type === "phrase") {
    return (
      <div className="explanation-view">
        <h2>{String(explanation.phrase ?? "")}</h2>
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
      <h2>{String(explanation.selectedText ?? "")}</h2>
      <div className="popup-label">SENTENCE EXPLANATION</div>
      <p>{String(explanation.simpleExplanation ?? "")}</p>
      {Array.isArray(explanation.keyPoints) && explanation.keyPoints.length > 0 && (
        <>
          <div className="popup-label">KEY POINTS</div>
          <ul>{explanation.keyPoints.map((point) => <li key={String(point)}>{String(point)}</li>)}</ul>
        </>
      )}
    </div>
  );
}
