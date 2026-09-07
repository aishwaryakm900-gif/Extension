import { GoogleGenAI } from "@google/genai";
import { explanationSchema, normalizeExplanationData, type ExplainRequest, type Explanation } from "./validation";

export class AIServiceError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly retryable: boolean;

  constructor(message: string, code = "AI_SERVICE_ERROR", status = 502, retryable = true) {
    super(message);
    this.name = "AIServiceError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export function extractErrorStatus(err: unknown): number {
  if (!err || typeof err !== "object") return 500;
  const anyErr = err as Record<string, unknown>;
  if (typeof anyErr.status === "number") return anyErr.status;
  if (typeof anyErr.statusCode === "number") return anyErr.statusCode;

  const errorProp = anyErr.error as Record<string, unknown> | undefined;
  if (errorProp && typeof errorProp.code === "number") return errorProp.code;

  const msg = anyErr.message ? String(anyErr.message) : "";
  const match = msg.match(/\b(429|500|502|503|504)\b/);
  if (match) return parseInt(match[1], 10);

  return 500;
}

export function isTransientError(err: unknown): boolean {
  const status = extractErrorStatus(err);
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
    return true;
  }

  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  return (
    lower.includes("high demand") ||
    lower.includes("spikes in demand") ||
    lower.includes("temporarily unavailable") ||
    lower.includes("unavailable") ||
    lower.includes("resource_exhausted") ||
    lower.includes("quota exceeded") ||
    lower.includes("rate limit") ||
    lower.includes("overloaded") ||
    lower.includes("econnreset") ||
    lower.includes("etimedout") ||
    lower.includes("fetch failed") ||
    lower.includes("network")
  );
}

export function getCandidateModels(): string[] {
  const primary = process.env.AI_MODEL || process.env.GEMINI_MODEL;
  const fallback = process.env.AI_FALLBACK_MODEL || process.env.GEMINI_FALLBACK_MODEL;

  // Verified currently supported Gemini models for text generation in order of preference
  const validDefaults = [
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.6-flash",
    "gemini-3.7-flash",
    "gemini-flash-lite-latest"
  ];

  const candidateList: string[] = [];

  if (primary && primary.trim().length > 0) {
    candidateList.push(primary.trim());
  }

  if (fallback && fallback.trim().length > 0 && fallback.trim() !== primary?.trim()) {
    candidateList.push(fallback.trim());
  }

  for (const def of validDefaults) {
    if (!candidateList.includes(def)) {
      candidateList.push(def);
    }
  }

  return candidateList;
}

const SYSTEM_INSTRUCTION = `You are Reader AI, an intelligent selection-aware reading companion.

CORE PRINCIPLE:
- "selectedText" is WHAT THE USER ACTUALLY SELECTED (the explanation target).
- "context" is ONLY the immediate surrounding sentence/clause provided as background reference.
- NEVER confuse the two. Do not explain the entire context when the user selected a single word!
- "selectedText" must be a meaningful, searchable target. If the text appears slightly incomplete or malformed due to browser selection artifacts, determine the intended word using the immediate context only if strongly supported. Never invent an unrelated word.
- Never treat random punctuation or corrupted fragments as legitimate English phrases.

SELECTION-AWARE RULES:

CASE 1 — SINGLE WORD, CAMELCASE TERM, OR TECHNICAL TERM:
- The user wants the meaning and pronunciation of this specific word/term.
- If the selection is CamelCase (e.g. "CloudComputing", "StateManagement"), normalize to natural space-separated words (e.g. "Cloud Computing", "State Management") in "resolvedTerm".
- "pronunciation": Accurate IPA phonetic transcription enclosed in slashes (e.g. "/ˈstrɛtʃɪz/", "/ˈnæʃənəl/", "/klaʊd kəmˈpjuːtɪŋ/", "/ˌsiː plʌs ˈplʌs/"). NEVER simply wrap the original text with slashes (e.g. NEVER "/cloudcomputing/"). If reliable IPA cannot be determined, omit this field.
- "phoneticGuide": Student-friendly readable pronunciation guide (e.g. "NASH-uh-nuhl", "cloud kuhm-PYOO-ting", "MAN-ij-muhnt", "SEE-plus-plus").
- "spokenText": The exact natural words to pass to text-to-speech (e.g. "Cloud Computing", "C plus plus", "R-E-S-T A-P-I", "L-L-M").
- "meaning": Concise, clear definition of the word/term.
- "simpleMeaning": Everyday plain-English meaning.
- "contextExplanation": A very short, 1-sentence note clarifying how this word/term is functioning in this specific sentence.
- DO NOT summarize or explain the entire sentence. Keep it focused on the word/term!
- "example": Brief illustrative sentence.

CASE 2 — PHRASE OR IDIOM:
- The user wants the meaning and pronunciation of the phrase/idiom as a whole (e.g. "machine learning", "artificial intelligence", "large language model").
- "pronunciation": Accurate IPA for the whole phrase (e.g. "/məˈʃiːn ˈlɜːrnɪŋ/").
- "phoneticGuide": Student-friendly readable pronunciation guide (e.g. "muh-SHEEN LURN-ing").
- "spokenText": The natural words to speak out loud.
- "meaning": What the phrase or idiom means.
- "simpleExplanation": Plain-English explanation.
- "contextExplanation": How it applies in this context.

CASE 3 — COMPLETE SENTENCE:
- The user is asking "What does this sentence mean in the context I am reading?".
- "simpleExplanation": Explain what the entire sentence means naturally, simply, and clearly.
- Do NOT output a dictionary-style word definition.
- "keyPoints": [Key takeaway 1, Key takeaway 2] (optional if simple sentence).

CASE 4 — PASSAGE / MULTIPLE SENTENCES:
- The user wants a summary/explanation of the selected passage.
- "simpleExplanation": Concise summary of what the passage communicates.
- "keyPoints": Main takeaways.

OUTPUT FORMAT:
Return ONLY a valid JSON object matching:

For word or technical term:
{
  "type": "word",
  "word": "<the word or term>",
  "resolvedTerm": "<normalized term, e.g. Cloud Computing>",
  "partOfSpeech": "<part of speech>",
  "pronunciation": "<Real IPA, e.g. /ˈstrɛtʃɪz/ or /klaʊd kəmˈpjuːtɪŋ/>",
  "phoneticGuide": "<readable pronunciation, e.g. STRETCH-iz or cloud kuhm-PYOO-ting>",
  "spokenText": "<spoken words for TTS, e.g. Cloud Computing>",
  "meaning": "<definition of the word>",
  "simpleMeaning": "<everyday meaning>",
  "contextExplanation": "<brief 1-sentence contextual note>",
  "example": "<example sentence>"
}

For phrase:
{
  "type": "phrase",
  "phrase": "<phrase>",
  "resolvedTerm": "<phrase>",
  "pronunciation": "<Real IPA for the whole phrase>",
  "phoneticGuide": "<readable pronunciation for the whole phrase>",
  "spokenText": "<spoken phrase for TTS>",
  "meaning": "<phrase meaning>",
  "simpleExplanation": "<plain-English explanation>",
  "contextExplanation": "<contextual note>"
}

For sentence or passage:
{
  "type": "explanation",
  "selectedText": "<selected sentence or passage>",
  "simpleExplanation": "<what the sentence or passage means in plain English>",
  "keyPoints": ["<point 1>", "<point 2>"]
}`;

export async function explainInContext(input: ExplainRequest): Promise<Explanation> {
  const apiKey = process.env.GEMINI_API_KEY || process.env.AI_API_KEY;
  if (!apiKey) {
    console.error("[Reader AI Server] Neither GEMINI_API_KEY nor AI_API_KEY is configured in the environment.");
    throw new AIServiceError(
      "GEMINI_API_KEY is not configured on the server. Please set GEMINI_API_KEY in .env.local.",
      "CONFIG_ERROR",
      500,
      false
    );
  }

  const ai = new GoogleGenAI({ apiKey });
  const termToExplain = input.resolvedSelection || input.selectedText;
  const minimalContext = input.context || input.sentence || termToExplain;

  const userPrompt = JSON.stringify({
    selectedText: termToExplain,
    selectionType: input.selectionType,
    context: minimalContext,
    originalSelection: input.originalSelection || termToExplain
  }, null, 2);

  let lastError: unknown = null;
  const candidateModels = getCandidateModels();

  for (const model of candidateModels) {
    const maxRetries = 2;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (attempt > 1) {
        const backoffMs = attempt * 600; // pass 2 -> 600ms, pass 3 -> 1200ms
        console.log(`[Reader AI Server] Waiting ${backoffMs}ms before retrying model "${model}" (attempt ${attempt})...`);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }

      try {
        const response = await ai.models.generateContent({
          model,
          contents: [
            { role: "user", parts: [{ text: `${SYSTEM_INSTRUCTION}\n\nReader Selection Context:\n${userPrompt}` }] }
          ],
          config: {
            temperature: 0.2,
            responseMimeType: "application/json"
          }
        });

        const rawText = response.text ?? "";
        const explanation = tryParseExplanation(rawText, termToExplain);
        if (explanation) {
          return explanation;
        }

        // If initial parsing failed, attempt one strict JSON formatting pass
        console.warn(`[Reader AI Server] Gemini response from "${model}" failed schema validation. Attempting JSON recovery...`);
        const retryResponse = await ai.models.generateContent({
          model,
          contents: [
            {
              role: "user",
              parts: [{
                text: `Convert this explanation for "${termToExplain}" into strictly valid JSON without markdown fences:\n${rawText}\n\nRequired format: {"type":"word"|"phrase"|"explanation", ...}`
              }]
            }
          ],
          config: {
            temperature: 0.1,
            responseMimeType: "application/json"
          }
        });

        const retryExplanation = tryParseExplanation(retryResponse.text ?? "", termToExplain);
        if (retryExplanation) {
          return retryExplanation;
        }

        throw new AIServiceError("Gemini returned invalid response format", "PARSE_ERROR", 502, true);
      } catch (err: unknown) {
        lastError = err;
        const status = extractErrorStatus(err);
        const errorMessage = err instanceof Error ? err.message : String(err);
        const transient = isTransientError(err);

        console.warn(`[Reader AI Server] Model "${model}" attempt ${attempt} failed [status: ${status}]: ${errorMessage}`);

        // If it is an unrecoverable auth error (invalid API key), stop retrying immediately
        if (status === 401 || status === 403 || errorMessage.toLowerCase().includes("api key not valid")) {
          throw new AIServiceError("Invalid API key or unauthorized access.", "AUTH_ERROR", 401, false);
        }

        // If 503 high demand or 404 model not found, switch immediately to fallback model
        if (status === 503 || status === 404 || errorMessage.toLowerCase().includes("high demand") || errorMessage.toLowerCase().includes("not found")) {
          console.log(`[Reader AI Server] Model "${model}" is unavailable or experiencing high demand. Switching to next candidate model...`);
          break; // Break retry loop on this model, proceed to next candidate model
        }

        if (!transient && attempt >= maxRetries) {
          break;
        }
      }
    }
  }

  console.error("[Reader AI Server] All candidate models exhausted. Last error:", lastError);
  const isTransient = isTransientError(lastError);
  const status = isTransient ? 503 : 502;
  const message = isTransient ? "AI service temporarily unavailable. Please try again." : "AI service failure. Please try again.";

  throw new AIServiceError(message, isTransient ? "AI_BUSY" : "UPSTREAM_ERROR", status, isTransient);
}

function cleanJsonString(raw: string): string {
  let cleaned = raw.trim();
  // Strip markdown fences ```json ... ``` or ``` ... ```
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }
  return cleaned.trim();
}

function tryParseExplanation(rawText: string, fallbackTerm: string): Explanation | null {
  if (!rawText) return null;

  try {
    const cleaned = cleanJsonString(rawText);
    const parsed: unknown = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== "object") return null;

    const normalized = normalizeExplanationData(parsed as Record<string, unknown>);
    const result = explanationSchema.safeParse(normalized);
    if (result.success) {
      return result.data;
    }

    console.warn("[Reader AI] Explanation schema validation issue:", result.error.format());
    return null;
  } catch (err) {
    // Attempt regex extraction of JSON object if wrapped in explanatory text
    const match = rawText.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const fallbackParsed: unknown = JSON.parse(match[0]);
        if (fallbackParsed && typeof fallbackParsed === "object") {
          const normalized = normalizeExplanationData(fallbackParsed as Record<string, unknown>);
          const result = explanationSchema.safeParse(normalized);
          if (result.success) return result.data;
        }
      } catch {
        // Fall through to null
      }
    }
    return null;
  }
}
