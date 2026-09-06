chrome.runtime.onInstalled.addListener(() => {
  console.info("Reader AI extension installed");
});

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isExplainMessage(message)) return false;

  explain(message.payload)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : "Unable to explain this selection right now.";
      sendResponse({ ok: false, error: message });
    });

  return true;
});

async function explain(payload: ExplainPayload): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch("http://localhost:3000/api/explain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (netErr: unknown) {
    throw new Error("Cannot reach Reader AI server on http://localhost:3000. Is Next.js running?");
  }

  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new Error(`Server returned status ${response.status} with non-JSON response.`);
  }

  if (!response.ok) {
    const errorObj = result as { error?: string; code?: string };
    const errText = errorObj.error || `Server responded with status ${response.status}`;
    throw new Error(errText);
  }

  return result;
}

type ExplainPayload = {
  originalSelection?: string;
  resolvedSelection?: string;
  selectedText: string;
  selectionType: "word" | "partial-word" | "phrase" | "sentence" | "passage" | "unknown";
  context?: string;
  sentence: string;
  paragraph: string;
  surroundingContext: string;
  pageTitle: string;
  sourceUrl: string;
  sourceType: "webpage" | "pdf";
  pageNumber?: number;
};

function isExplainMessage(message: unknown): message is { type: "EXPLAIN"; payload: ExplainPayload } {
  if (!message || typeof message !== "object" || !("type" in message) || message.type !== "EXPLAIN" || !("payload" in message) || !message.payload || typeof message.payload !== "object") {
    return false;
  }

  const payload = message.payload as Record<string, unknown>;
  return typeof payload.selectedText === "string" && typeof payload.selectionType === "string";
}
