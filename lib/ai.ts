import { GoogleGenAI } from "@google/genai";
import { explanationSchema, normalizeExplanationData, type ExplainRequest, type Explanation } from "./validation";

export class AIServiceError extends Error {
  public readonly code: string;
  public readonly status: number;

  constructor(message: string, code = "AI_SERVICE_ERROR", status = 502) {
    super(message);
    this.name = "AIServiceError";
    this.code = code;
    this.status = status;
  }
}

function getCandidateModels(): string[] {
  const envModel = process.env.GEMINI_MODEL || (process.env.AI_MODEL?.includes("gemini") ? process.env.AI_MODEL : undefined);
  const models = [
    envModel,
    "gemini-flash-latest",
    "gemini-3.1-flash-lite",
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3.7-flash",
    "gemini-flash-lite-latest"
  ].filter(Boolean) as string[];

  return Array.from(new Set(models));
}

const SYSTEM_INSTRUCTION = `You are Reader AI, an intelligent selection-aware reading companion.

CORE PRINCIPLE:
- "selectedText" is WHAT THE USER ACTUALLY SELECTED (the explanation target).
- "context" is ONLY the immediate surrounding sentence/clause provided as background reference.
- NEVER confuse the two. Do not explain the entire context when the user selected a single word!

SELECTION-AWARE RULES:

CASE 1 — SINGLE WORD (or PARTIAL WORD resolved to a word):
- The user wants the meaning of this specific word.
- "meaning": Concise, clear definition of the word.
- "simpleMeaning": Everyday plain-English meaning.
- "contextExplanation": A very short, 1-sentence note clarifying how this word is functioning in this specific sentence (e.g., if "cold" in "cold look", explain it means emotionally distant/unfriendly; if "congratulations", explain the expression of praise in this context).
- DO NOT summarize or explain the entire sentence. Keep it focused on the word!
- "example": Brief illustrative sentence.

CASE 2 — PHRASE OR IDIOM:
- The user wants the meaning of the phrase/idiom as a whole.
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

For word:
{
  "type": "word",
  "word": "<the word>",
  "partOfSpeech": "<part of speech>",
  "meaning": "<definition of the word>",
  "simpleMeaning": "<everyday meaning>",
  "contextExplanation": "<brief 1-sentence contextual note>",
  "example": "<example sentence>"
}

For phrase:
{
  "type": "phrase",
  "phrase": "<phrase>",
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
      500
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

  // Attempt generation, with fallback across candidate models and a retry pass if transient 503/429 occurs
  const candidateModels = getCandidateModels();
  const maxPasses = 2;

  for (let pass = 1; pass <= maxPasses; pass++) {
    for (const model of candidateModels) {
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

        // If parsing failed, retry once with a strict formatting prompt
        console.warn(`[Reader AI] Gemini response from ${model} failed validation. Retrying with strict JSON prompt...`);
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

        throw new AIServiceError(`Gemini returned unparseable explanation format: ${rawText.slice(0, 200)}`, "PARSE_ERROR", 502);
      } catch (err: unknown) {
        lastError = err;
        const errorMessage = err instanceof Error ? err.message : String(err);
        const isRetriable = errorMessage.includes("503") ||
                            errorMessage.includes("429") ||
                            errorMessage.includes("404") ||
                            errorMessage.includes("demand") ||
                            errorMessage.includes("UNAVAILABLE") ||
                            errorMessage.includes("RESOURCE_EXHAUSTED") ||
                            errorMessage.includes("NOT_FOUND");

        console.warn(`[Reader AI] Attempt with model ${model} (pass ${pass}) failed: ${errorMessage}`);
        if (!isRetriable) {
          break; // Don't try other models if it's an invalid key or client error
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }

    if (pass < maxPasses) {
      console.log("[Reader AI] Waiting 1.5s before retry pass for high demand spike...");
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  console.error("[Reader AI Server] All Gemini explanation attempts failed:", lastError);
  const detail = lastError instanceof Error ? lastError.message : "Upstream AI provider failed.";
  throw new AIServiceError(`AI service failure: ${detail}`, "UPSTREAM_ERROR", 502);
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
