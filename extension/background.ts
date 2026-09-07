chrome.runtime.onInstalled.addListener(() => {
  console.info("Reader AI extension installed");
});

type SpeakWordMessage = {
  type: "READER_AI_SPEAK" | "SPEAK_WORD" | "SPEAK_PRONUNCIATION";
  text: string;
  lang?: string;
};

function isSpeakWordMessage(message: unknown): message is SpeakWordMessage {
  if (!message || typeof message !== "object" || !("type" in message)) {
    return false;
  }
  const m = message as { type: unknown; text?: unknown };
  return (
    (m.type === "READER_AI_SPEAK" || m.type === "SPEAK_WORD" || m.type === "SPEAK_PRONUNCIATION") &&
    typeof m.text === "string" &&
    m.text.trim().length > 0
  );
}

type TestTtsMessage = {
  type: "READER_AI_TEST_TTS";
};

function isTestTtsMessage(message: unknown): message is TestTtsMessage {
  return !!message && typeof message === "object" && "type" in message && (message as { type: unknown }).type === "READER_AI_TEST_TTS";
}

type StopTtsMessage = {
  type: "STOP_TTS" | "READER_AI_TTS_STOP";
};

function isStopTtsMessage(message: unknown): message is StopTtsMessage {
  return !!message && typeof message === "object" && "type" in message &&
    ((message as { type: unknown }).type === "STOP_TTS" || (message as { type: unknown }).type === "READER_AI_TTS_STOP");
}

function logAvailableVoices(): void {
  if (typeof chrome !== "undefined" && chrome.tts && chrome.tts.getVoices) {
    chrome.tts.getVoices((voices) => {
      const voiceNames = voices ? voices.map((v) => `${v.voiceName} (${v.lang})`) : [];
      console.log("[Reader AI] chrome.tts available voices (" + voiceNames.length + "):", voiceNames);
    });
  }
}

// Log voices on startup/install
logAvailableVoices();

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (isTestTtsMessage(message)) {
    console.log("[Reader AI] TTS test message received");
    handleTestTts(sendResponse);
    return true;
  }

  if (isSpeakWordMessage(message)) {
    console.log("[Reader AI TTS] Service worker received SPEAK_WORD:", message.text);
    handleSpeakWord(message, sender, sendResponse);
    return true;
  }

  if (isStopTtsMessage(message)) {
    handleStopTts(sendResponse);
    return false;
  }

  if (!isExplainMessage(message)) return false;

  explain(message.payload)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : "Unable to explain this selection right now.";
      sendResponse({ ok: false, error: message });
    });

  return true;
});

function handleTestTts(sendResponse: (response: { success: boolean; ok?: boolean; error?: string }) => void): void {
  if (typeof chrome === "undefined" || !chrome.tts) {
    console.error("[Reader AI] TTS ERROR: chrome.tts API is not available");
    sendResponse({ success: false, ok: false, error: "chrome.tts API is not available" });
    return;
  }

  try {
    let hasSpoken = false;
    const doSpeak = () => {
      if (hasSpoken) return;
      hasSpoken = true;
      chrome.tts.speak(
        "Hello from Reader AI",
        {
          lang: "en-US",
          rate: 0.8,
          pitch: 1.0,
          volume: 1.0,
          enqueue: false,
          onEvent: (event: chrome.tts.TtsEvent) => {
            console.log("[Reader AI] TTS test onEvent:", event.type);
          }
        },
        () => {
          if (chrome.runtime.lastError) {
            console.error("[Reader AI] TTS ERROR:", chrome.runtime.lastError.message);
            sendResponse({ success: false, ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          console.log("[Reader AI] TTS started");
          sendResponse({ success: true, ok: true });
        }
      );
    };

    try {
      (chrome.tts.stop as unknown as (cb?: () => void) => void)(() => {
        doSpeak();
      });
    } catch {
      // ignore
    }
    doSpeak();
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[Reader AI] TTS ERROR:", errMsg);
    sendResponse({ success: false, ok: false, error: errMsg });
  }
}

function handleSpeakWord(
  message: SpeakWordMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: { success: boolean; ok?: boolean; error?: string }) => void
): void {
  const text = String(message.text || "").trim();

  console.log("[Reader AI TTS] Service worker received request:", text);

  if (!text) {
    console.error("[Reader AI TTS] Error: Empty text");
    sendResponse({ success: false, ok: false, error: "Empty text" });
    return;
  }

  const chromeTtsAvailable = typeof chrome !== "undefined" && typeof chrome.tts !== "undefined" && typeof chrome.tts.speak === "function";
  console.log("[Reader AI TTS] chrome.tts available:", chromeTtsAvailable);

  if (!chromeTtsAvailable) {
    console.error("[Reader AI TTS] Error: chrome.tts is not available");
    sendResponse({ success: false, ok: false, error: "chrome.tts is not available" });
    return;
  }

  try {
    try {
      chrome.tts.stop();
    } catch {
      // ignore
    }

    console.log("[Reader AI TTS] Calling chrome.tts.speak:", text);

    chrome.tts.speak(
      text,
      {
        lang: message.lang || "en-US",
        rate: 0.8,
        pitch: 1.0,
        volume: 1.0,
        enqueue: false,
        onEvent: (event: chrome.tts.TtsEvent) => {
          console.log("[Reader AI TTS] Event:", event.type);
          if (event.type === "error") {
            console.error("[Reader AI TTS] Error:", event.errorMessage);
          }

          const isSpeaking = event.type === "start" || event.type === "resume";
          const isFinished =
            event.type === "end" ||
            event.type === "interrupted" ||
            event.type === "cancelled" ||
            event.type === "error";

          if (sender.tab?.id) {
            chrome.tabs.sendMessage(sender.tab.id, {
              type: "TTS_STATE_CHANGE",
              eventType: event.type,
              isSpeaking: isSpeaking && !isFinished,
              error: event.errorMessage
            }).catch(() => {
              // Ignore if sender tab is closed or navigated
            });
          }
        }
      },
      () => {
        if (chrome.runtime.lastError) {
          console.error(
            "[Reader AI TTS] Error:",
            chrome.runtime.lastError.message
          );
          sendResponse({
            success: false,
            ok: false,
            error: chrome.runtime.lastError.message
          });
          return;
        }

        sendResponse({
          success: true,
          ok: true
        });
      }
    );
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[Reader AI TTS] Error:", errMsg);
    sendResponse({ success: false, ok: false, error: errMsg });
  }
}

function handleStopTts(sendResponse: (response: { success: boolean; ok?: boolean; error?: string }) => void): void {
  if (typeof chrome !== "undefined" && chrome.tts) {
    try {
      chrome.tts.stop();
    } catch (err) {
      console.warn("[Reader AI Background] Error stopping TTS:", err);
    }
  }
  sendResponse({ success: true, ok: true });
}

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
    const errorObj = result as { error?: string; code?: string; retryable?: boolean; success?: boolean };
    const errText = errorObj.error || (response.status === 503 || response.status === 429
      ? "AI is temporarily busy. Please try again."
      : `Server responded with status ${response.status}`);
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
