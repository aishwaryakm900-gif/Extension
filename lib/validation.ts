import { z } from "zod";
import { isValidIpa } from "./pronunciation";

export const selectionTypeSchema = z.enum(["word", "partial-word", "phrase", "sentence", "passage", "unknown"]);

export const explainRequestSchema = z.object({
  selectedText: z.string().trim().min(1).max(2000),
  originalSelection: z.string().trim().min(1).max(2000).optional(),
  resolvedSelection: z.string().trim().min(1).max(2000).optional(),
  selectionType: selectionTypeSchema,
  sentence: z.string().trim().min(1).max(4000).optional().default(""),
  paragraph: z.string().trim().min(1).max(5000).optional().default(""),
  surroundingContext: z.string().trim().min(1).max(8000).optional().default(""),
  context: z.string().trim().max(8000).optional(),
  pageTitle: z.string().trim().max(500).optional(),
  sourceUrl: z.string().max(2048).optional(),
  sourceType: z.enum(["webpage", "pdf"]).optional().default("webpage"),
  pageNumber: z.number().int().positive().optional()
}).transform((data) => {
  const resolved = data.resolvedSelection || data.selectedText;
  const original = data.originalSelection || data.selectedText;
  const mainContext = data.context || data.surroundingContext || data.paragraph || data.sentence || resolved;
  const sentence = data.sentence || mainContext;
  const paragraph = data.paragraph || mainContext;
  const surroundingContext = data.surroundingContext || mainContext;

  return {
    ...data,
    selectedText: resolved,
    resolvedSelection: resolved,
    originalSelection: original,
    sentence,
    paragraph,
    surroundingContext,
    context: mainContext
  };
});

const wordExplanationSchema = z.object({
  type: z.literal("word"),
  word: z.string().trim().min(1),
  resolvedTerm: z.string().trim().optional(),
  partOfSpeech: z.string().trim().min(1).default("word"),
  pronunciation: z.string().trim().optional(),
  phoneticGuide: z.string().trim().optional(),
  spokenText: z.string().trim().optional(),
  meaning: z.string().trim().min(1),
  simpleMeaning: z.string().trim().min(1),
  contextExplanation: z.string().trim().min(1),
  example: z.string().trim().min(1)
});

const phraseExplanationSchema = z.object({
  type: z.literal("phrase"),
  phrase: z.string().trim().min(1),
  resolvedTerm: z.string().trim().optional(),
  pronunciation: z.string().trim().optional(),
  phoneticGuide: z.string().trim().optional(),
  spokenText: z.string().trim().optional(),
  meaning: z.string().trim().min(1),
  simpleExplanation: z.string().trim().min(1),
  contextExplanation: z.string().trim().min(1)
});

const passageExplanationSchema = z.object({
  type: z.literal("explanation"),
  selectedText: z.string().trim().min(1),
  simpleExplanation: z.string().trim().min(1),
  keyPoints: z.array(z.string().trim().min(1)).max(8).default([])
});

export const explanationSchema = z.discriminatedUnion("type", [
  wordExplanationSchema,
  phraseExplanationSchema,
  passageExplanationSchema
]);

export type ExplainRequest = z.infer<typeof explainRequestSchema>;
export type Explanation = z.infer<typeof explanationSchema>;

/**
 * Normalizes raw Gemini output if keys vary slightly (e.g. `term` -> `word`, `contextualMeaning` -> `contextExplanation`).
 */
export function normalizeExplanationData(raw: Record<string, unknown>): unknown {
  const data = { ...raw };

  // If type was omitted or unrecognized, infer from fields
  if (!data.type || (data.type !== "word" && data.type !== "phrase" && data.type !== "explanation")) {
    if (data.phrase) data.type = "phrase";
    else if (data.keyPoints || data.selectedText) data.type = "explanation";
    else data.type = "word";
  }

  // Map phoneticGuide / soundsLike / phonetic
  if (!data.phoneticGuide && data.phonetic) data.phoneticGuide = String(data.phonetic);
  if (!data.phoneticGuide && data.soundsLike) data.phoneticGuide = String(data.soundsLike);

  if (data.type === "word") {
    if (!data.word && data.term) data.word = data.term;
    if (!data.word && data.selectedText) data.word = data.selectedText;
    if (!data.partOfSpeech) data.partOfSpeech = "word";

    let ipaCandidate: string | undefined;
    if (typeof data.pronunciation === "string") {
      ipaCandidate = data.pronunciation.trim();
    } else if (typeof data.ipa === "string") {
      ipaCandidate = data.ipa.trim();
    }

    if (ipaCandidate) {
      if (!ipaCandidate.startsWith("/")) ipaCandidate = `/${ipaCandidate}`;
      if (!ipaCandidate.endsWith("/")) ipaCandidate = `${ipaCandidate}/`;
      // Validate: Must be genuine IPA, not just the original text enclosed in slashes
      const termToCheck = String(data.word || data.resolvedTerm || "");
      if (isValidIpa(ipaCandidate, termToCheck)) {
        data.pronunciation = ipaCandidate;
      } else {
        data.pronunciation = undefined;
      }
    } else {
      data.pronunciation = undefined;
    }

    if (!data.simpleMeaning && data.meaning) data.simpleMeaning = data.meaning;
    if (!data.contextExplanation && data.contextualMeaning) data.contextExplanation = data.contextualMeaning;
    if (!data.contextExplanation && data.meaning) data.contextExplanation = data.meaning;
    if (!data.meaning && data.contextExplanation) data.meaning = data.contextExplanation;
    if (!data.example) data.example = `Used in: "${String(data.word)}"`;
  } else if (data.type === "phrase") {
    if (!data.phrase && data.term) data.phrase = data.term;
    if (!data.phrase && data.selectedText) data.phrase = data.selectedText;

    let ipaCandidate: string | undefined;
    if (typeof data.pronunciation === "string") {
      ipaCandidate = data.pronunciation.trim();
    } else if (typeof data.ipa === "string") {
      ipaCandidate = data.ipa.trim();
    }

    if (ipaCandidate) {
      if (!ipaCandidate.startsWith("/")) ipaCandidate = `/${ipaCandidate}`;
      if (!ipaCandidate.endsWith("/")) ipaCandidate = `${ipaCandidate}/`;
      const termToCheck = String(data.phrase || data.resolvedTerm || "");
      if (isValidIpa(ipaCandidate, termToCheck)) {
        data.pronunciation = ipaCandidate;
      } else {
        data.pronunciation = undefined;
      }
    } else {
      data.pronunciation = undefined;
    }

    if (!data.simpleExplanation && data.meaning) data.simpleExplanation = data.meaning;
    if (!data.contextExplanation && data.contextualMeaning) data.contextExplanation = data.contextualMeaning;
    if (!data.contextExplanation && data.meaning) data.contextExplanation = data.meaning;
    if (!data.meaning && data.contextExplanation) data.meaning = data.contextExplanation;
  } else if (data.type === "explanation") {
    if (!data.selectedText && data.term) data.selectedText = data.term;
    if (!data.selectedText && data.word) data.selectedText = data.word;
    if (!data.simpleExplanation && data.meaning) data.simpleExplanation = data.meaning;
    if (!Array.isArray(data.keyPoints)) data.keyPoints = [];
  }

  return data;
}
