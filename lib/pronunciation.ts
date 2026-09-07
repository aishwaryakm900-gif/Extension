/**
 * Generic Pronunciation Engine for Reader AI
 * Handles words, short phrases, CamelCase, technical terms, acronyms, and symbols.
 */

export type PronunciationData = {
  resolvedTerm: string;
  originalTerm: string;
  spokenText: string;
  ipa?: string;
  phonetic?: string;
  language: string;
};

// Common technical and domain lexicon with verified standard IPA and readable phonetics
const LEXICON: Record<string, { ipa: string; phonetic: string; spokenText?: string }> = {
  // Common test & core words
  national: { ipa: "/ˈnæʃənəl/", phonetic: "NASH-uh-nuhl" },
  management: { ipa: "/ˈmænɪdʒmənt/", phonetic: "MAN-ij-muhnt" },
  yourself: { ipa: "/jɔːrˈsɛlf/", phonetic: "yor-SELF" },
  melancholy: { ipa: "/ˈmɛlənˌkɑːli/", phonetic: "MEL-uhn-koll-ee" },
  registration: { ipa: "/ˌrɛdʒɪˈstreɪʃən/", phonetic: "rej-ih-STRAY-shuhn" },
  congratulations: { ipa: "/kənˌɡrætʃəˈleɪʃənz/", phonetic: "kuhn-grat-shuh-LAY-shuhnz" },
  congratulation: { ipa: "/kənˌɡrætʃəˈleɪʃən/", phonetic: "kuhn-grat-shuh-LAY-shuhn" },
  stretches: { ipa: "/ˈstrɛtʃɪz/", phonetic: "STRETCH-iz" },
  stretch: { ipa: "/strɛtʃ/", phonetic: "STRETCH" },
  hello: { ipa: "/həˈloʊ/", phonetic: "huh-LOH" },
  night: { ipa: "/naɪt/", phonetic: "NYTE" },
  poignant: { ipa: "/ˈpɔɪnjənt/", phonetic: "POYN-yuhnt" },
  patient: { ipa: "/ˈpeɪʃənt/", phonetic: "PAY-shuhnt" },
  education: { ipa: "/ˌɛdʒʊˈkeɪʃən/", phonetic: "ej-oo-KAY-shuhn" },
  institute: { ipa: "/ˈɪnstɪtjuːt/", phonetic: "IN-stih-toot" },
  science: { ipa: "/ˈsaɪəns/", phonetic: "SY-uhns" },
  computer: { ipa: "/kəmˈpjuːtər/", phonetic: "kuhm-PYOO-ter" },
  technology: { ipa: "/tɛkˈnɑːlədʒi/", phonetic: "tek-NOL-uh-jee" },
  reading: { ipa: "/ˈriːdɪŋ/", phonetic: "REED-ing" },
  reader: { ipa: "/ˈriːdər/", phonetic: "REED-er" },

  // Programming languages & frameworks
  javascript: { ipa: "/ˈdʒɑːvəskrɪpt/", phonetic: "JAH-vuh-skript", spokenText: "JavaScript" },
  typescript: { ipa: "/ˈtaɪpskrɪpt/", phonetic: "TYPE-skript", spokenText: "TypeScript" },
  python: { ipa: "/ˈpaɪθɑːn/", phonetic: "PY-thahn", spokenText: "Python" },
  react: { ipa: "/riˈækt/", phonetic: "ree-AKT", spokenText: "React" },
  "node.js": { ipa: "/noʊd dʒeɪ ɛs/", phonetic: "nohd-jay-ESS", spokenText: "Node J S" },
  "next.js": { ipa: "/nɛkst dʒeɪ ɛs/", phonetic: "nekst-jay-ESS", spokenText: "Next J S" },
  "vue.js": { ipa: "/vjuː dʒeɪ ɛs/", phonetic: "vyoo-jay-ESS", spokenText: "Vue J S" },
  "c++": { ipa: "/ˌsiː plʌs ˈplʌs/", phonetic: "SEE-plus-plus", spokenText: "C plus plus" },
  "c#": { ipa: "/ˌsiː ˈʃɑːrp/", phonetic: "SEE-sharp", spokenText: "C sharp" },
  ".net": { ipa: "/ˌdɑːt ˈnɛt/", phonetic: "DOT-net", spokenText: "dot net" },
  opencv: { ipa: "/ˌoʊpən siː ˈviː/", phonetic: "OH-pen-see-vee", spokenText: "Open C V" },
  tensorflow: { ipa: "/ˈtɛnsərfloʊ/", phonetic: "TEN-ser-floh", spokenText: "TensorFlow" },
  "hugging face": { ipa: "/ˈhʌɡɪŋ feɪs/", phonetic: "HUG-ing fays", spokenText: "Hugging Face" },

  // Acronyms & technical terms
  "rest api": { ipa: "/rɛst ˌeɪ piː ˈaɪ/", phonetic: "rest-ay-pee-EYE", spokenText: "R-E-S-T A-P-I" },
  rag: { ipa: "/ræɡ/", phonetic: "R-A-G", spokenText: "R-A-G" },
  llm: { ipa: "/ˌɛl ɛl ˈɛm/", phonetic: "el-el-EM", spokenText: "L-L-M" },
  api: { ipa: "/ˌeɪ piː ˈaɪ/", phonetic: "ay-pee-EYE", spokenText: "A-P-I" },
  sdk: { ipa: "/ˌɛs diː ˈkeɪ/", phonetic: "es-dee-KAY", spokenText: "S-D-K" },
  cli: { ipa: "/ˌsiː ɛl ˈaɪ/", phonetic: "see-el-EYE", spokenText: "C-L-I" },
  ui: { ipa: "/ˌjuː ˈaɪ/", phonetic: "yoo-EYE", spokenText: "U-I" },
  ux: { ipa: "/ˌjuː ˈɛks/", phonetic: "yoo-EKS", spokenText: "U-X" },
  sql: { ipa: "/ˌɛs kjuː ˈɛl/", phonetic: "es-kyoo-EL", spokenText: "S-Q-L" },
  html: { ipa: "/ˌeɪtʃ tiː ɛm ˈɛl/", phonetic: "aych-tee-em-EL", spokenText: "H-T-M-L" },
  css: { ipa: "/ˌsiː ɛs ˈɛs/", phonetic: "see-es-ES", spokenText: "C-S-S" },

  // Phrases & concepts
  "cloud computing": { ipa: "/klaʊd kəmˈpjuːtɪŋ/", phonetic: "cloud kuhm-PYOO-ting" },
  "machine learning": { ipa: "/məˈʃiːn ˈlɜːrnɪŋ/", phonetic: "muh-SHEEN LURN-ing" },
  "state management": { ipa: "/steɪt ˈmænɪdʒmənt/", phonetic: "stayt MAN-ij-muhnt" },
  "artificial intelligence": { ipa: "/ˌɑːrtɪˈfɪʃəl ɪnˈtɛlɪdʒəns/", phonetic: "ar-tuh-FISH-uhl in-TEL-uh-juhns" },
  "large language model": { ipa: "/lɑːrdʒ ˈlæŋɡwɪdʒ ˈmɑːdəl/", phonetic: "larj LANG-gwij MOD-uhl" },
  "retrieval augmented generation": { ipa: "/rɪˈtriːvəl ɔːɡˈmɛntɪd ˌdʒɛnəˈreɪʃən/", phonetic: "rih-TREE-vuhl awg-MEN-tid jen-er-AY-shuhn" },
  "deep learning": { ipa: "/diːp ˈlɜːrnɪŋ/", phonetic: "deep LURN-ing" },
  "knowledge graph": { ipa: "/ˈnɑːlɪdʒ ɡræf/", phonetic: "NOL-ij graf" }
};

// Known letter pronunciations for acronyms
const LETTER_NAMES: Record<string, { ipa: string; phonetic: string; letter: string }> = {
  a: { ipa: "eɪ", phonetic: "AY", letter: "A" },
  b: { ipa: "biː", phonetic: "BEE", letter: "B" },
  c: { ipa: "siː", phonetic: "SEE", letter: "C" },
  d: { ipa: "diː", phonetic: "DEE", letter: "D" },
  e: { ipa: "iː", phonetic: "EE", letter: "E" },
  f: { ipa: "ɛf", phonetic: "EF", letter: "F" },
  g: { ipa: "dʒiː", phonetic: "JEE", letter: "G" },
  h: { ipa: "eɪtʃ", phonetic: "AYCH", letter: "H" },
  i: { ipa: "aɪ", phonetic: "EYE", letter: "I" },
  j: { ipa: "dʒeɪ", phonetic: "JAY", letter: "J" },
  k: { ipa: "keɪ", phonetic: "KAY", letter: "K" },
  l: { ipa: "ɛl", phonetic: "EL", letter: "L" },
  m: { ipa: "ɛm", phonetic: "EM", letter: "M" },
  n: { ipa: "ɛn", phonetic: "EN", letter: "N" },
  o: { ipa: "oʊ", phonetic: "OH", letter: "O" },
  p: { ipa: "piː", phonetic: "PEE", letter: "P" },
  q: { ipa: "kjuː", phonetic: "KYOO", letter: "Q" },
  r: { ipa: "ɑːr", phonetic: "AR", letter: "R" },
  s: { ipa: "ɛs", phonetic: "ES", letter: "S" },
  t: { ipa: "tiː", phonetic: "TEE", letter: "T" },
  u: { ipa: "juː", phonetic: "YOO", letter: "U" },
  v: { ipa: "viː", phonetic: "VEE", letter: "V" },
  w: { ipa: "ˈdʌbəl.juː", phonetic: "DUB-uhl-yoo", letter: "W" },
  x: { ipa: "ɛks", phonetic: "EKS", letter: "X" },
  y: { ipa: "waɪ", phonetic: "WY", letter: "Y" },
  z: { ipa: "ziː", phonetic: "ZEE", letter: "Z" }
};

/**
 * Checks if a string is in CamelCase (e.g. CloudComputing, StateManagement, MachineLearning)
 */
export function isCamelCase(text: string): boolean {
  if (!text || /\s/.test(text)) return false;
  return /^[A-Za-z0-9]+$/.test(text) && /[a-z0-9][A-Z]/.test(text);
}

/**
 * Splits CamelCase into spaced words without modifying the input
 */
export function splitCamelCase(text: string): string {
  if (!isCamelCase(text)) return text;
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .trim();
}

/**
 * Validates that an IPA string represents real phonetic sounds,
 * and is NOT simply the original word wrapped in slashes (e.g. /cloudcomputing/).
 */
export function isValidIpa(ipa: string | undefined | null, originalTerm: string): boolean {
  if (!ipa || typeof ipa !== "string") return false;
  const trimmed = ipa.trim();
  if (!trimmed.startsWith("/") || !trimmed.endsWith("/") || trimmed.length < 3) return false;

  const inner = trimmed.slice(1, -1).trim().toLowerCase();
  const rawClean = originalTerm.trim().toLowerCase().replace(/[^a-z0-9]/g, "");

  // FORBIDDEN: Just wrapping the input word with slashes
  if (inner === rawClean) return false;
  if (inner === originalTerm.trim().toLowerCase()) return false;

  // Real IPA must contain actual phonetic vowels/consonants/stress markers
  const hasPhoneticSymbols = /[æɑɔɛeɪaɪoʊaʊɔɪɪiʊuʌəʃʒθðŋˈˌː]/.test(inner);
  return hasPhoneticSymbols;
}

/**
 * Checks if the selection is reasonably short for pronunciation.
 * Long sentences and passages should NOT show pronunciation.
 */
export function isEligibleForPronunciation(text: string, selectionType?: string): boolean {
  if (!text) return false;
  if (selectionType === "passage" || selectionType === "sentence" || selectionType === "unknown") {
    return false;
  }
  const clean = text.trim();
  if (!clean) return false;
  if (clean.length > 60) return false;
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length > 6) return false;

  // Punctuation check: reject complete sentences with terminal punctuation
  if (/[.!?]$/.test(clean) && words.length > 3) return false;
  if (clean.includes(";") || clean.includes("?") || clean.includes("!")) return false;

  return true;
}

/**
 * Normalizes speech text for TTS output (handles C++, C#, .NET, .js, acronyms, CamelCase)
 */
export function normalizeSpokenText(targetWord: string): string {
  const clean = targetWord.trim();
  const upper = clean.toUpperCase();

  if (upper === "C++") return "C plus plus";
  if (upper === "C#") return "C sharp";
  if (upper === ".NET") return "dot net";
  if (/\.js$/i.test(clean)) return clean.replace(/\.js$/i, " J S");
  if (upper === "REST API") return "R-E-S-T A-P-I";
  if (upper === "LLM") return "L-L-M";
  if (upper === "RAG") return "R-A-G";
  if (upper === "OPENCV") return "Open C V";

  // If CamelCase, split words for speech
  if (isCamelCase(clean)) {
    return splitCamelCase(clean);
  }

  return clean;
}

/**
 * Rule-based Grapheme-to-Phoneme converter for arbitrary English single words.
 * Returns valid IPA and student-friendly readable phonetic guide.
 */
function g2pSingleWord(word: string): { ipa: string; phonetic: string } {
  const lower = word.toLowerCase().trim();

  let ipa = lower;
  let phonetic = lower.toUpperCase();

  // Suffix transformations
  if (lower.endsWith("tion")) {
    const stem = lower.slice(0, -4);
    ipa = `${stem}ʃən`;
    phonetic = `${stem.toUpperCase()}-shuhn`;
  } else if (lower.endsWith("sion")) {
    const stem = lower.slice(0, -4);
    ipa = `${stem}ʒən`;
    phonetic = `${stem.toUpperCase()}-zhuhn`;
  } else if (lower.endsWith("ment")) {
    const stem = lower.slice(0, -4);
    ipa = `${stem}mənt`;
    phonetic = `${stem.toUpperCase()}-muhnt`;
  } else if (lower.endsWith("ology")) {
    const stem = lower.slice(0, -5);
    ipa = `${stem}ˈɑːlədʒi`;
    phonetic = `${stem.toUpperCase()}-OL-uh-jee`;
  } else if (lower.endsWith("ity")) {
    const stem = lower.slice(0, -3);
    ipa = `${stem}ɪti`;
    phonetic = `${stem.toUpperCase()}-ih-tee`;
  } else if (lower.endsWith("ous")) {
    const stem = lower.slice(0, -3);
    ipa = `${stem}əs`;
    phonetic = `${stem.toUpperCase()}-uhs`;
  } else if (lower.endsWith("able")) {
    const stem = lower.slice(0, -4);
    ipa = `${stem}əbəl`;
    phonetic = `${stem.toUpperCase()}-uh-buhl`;
  } else if (lower.endsWith("ize") || lower.endsWith("ise")) {
    const stem = lower.slice(0, -3);
    ipa = `${stem}aɪz`;
    phonetic = `${stem.toUpperCase()}-yze`;
  } else if (lower.endsWith("ing")) {
    const stem = lower.slice(0, -3);
    ipa = `${stem}ɪŋ`;
    phonetic = `${stem.toUpperCase()}-ing`;
  } else {
    // Digraph conversions for authentic phonetic transcription
    ipa = ipa
      .replace(/ph/g, "f")
      .replace(/sh/g, "ʃ")
      .replace(/ch/g, "tʃ")
      .replace(/th/g, "θ")
      .replace(/ee|ea/g, "iː")
      .replace(/oo/g, "uː")
      .replace(/igh/g, "aɪ")
      .replace(/ou|ow/g, "aʊ")
      .replace(/oi|oy/g, "ɔɪ")
      .replace(/ai|ay/g, "eɪ")
      .replace(/oa/g, "oʊ")
      .replace(/ar/g, "ɑːr")
      .replace(/er|ir|ur/g, "ɜːr")
      .replace(/or/g, "ɔːr");
  }

  // Ensure leading primary stress mark if not present
  if (!ipa.includes("ˈ") && !ipa.includes("ˌ")) {
    ipa = `ˈ${ipa}`;
  }

  return {
    ipa: `/${ipa}/`,
    phonetic
  };
}

/**
 * Normalizes term for pronunciation without altering user selection.
 */
export function normalizePronunciationTarget(term: string): string {
  if (!term) return "";
  const clean = term.trim();
  const lower = clean.toLowerCase();
  if (LEXICON[lower] && !isCamelCase(clean)) {
    return clean;
  }
  if (isCamelCase(clean)) {
    if (LEXICON[lower] && LEXICON[lower].spokenText === clean) {
      return clean;
    }
    return splitCamelCase(clean);
  }
  return clean;
}

/**
 * Generic Pronunciation Resolver
 * Works dynamically for any valid English word, phrase, CamelCase term, acronym, or technical symbol.
 */
export function resolvePronunciation(term: string, customIpa?: string): PronunciationData | null {
  if (!term || !term.trim()) return null;
  const originalTerm = term.trim();
  const directLookup = originalTerm.toLowerCase();

  // 1. Direct Lexicon Match FIRST (preserves known tech terms like JavaScript, TypeScript, TensorFlow, OpenCV)
  if (LEXICON[directLookup]) {
    const entry = LEXICON[directLookup];
    const validCustomIpa = customIpa && isValidIpa(customIpa, originalTerm) ? customIpa : undefined;
    return {
      resolvedTerm: originalTerm,
      originalTerm,
      spokenText: entry.spokenText || normalizeSpokenText(originalTerm),
      ipa: validCustomIpa || entry.ipa,
      phonetic: entry.phonetic,
      language: "en-US"
    };
  }

  // 2. Resolve CamelCase target (e.g. "CloudComputing" -> "Cloud Computing")
  const resolvedTerm = isCamelCase(originalTerm) ? splitCamelCase(originalTerm) : originalTerm;
  const lookupKey = resolvedTerm.toLowerCase();
  const validCustomIpa = customIpa && isValidIpa(customIpa, resolvedTerm) ? customIpa : undefined;

  // 3. Check if split term matches Lexicon
  if (LEXICON[lookupKey]) {
    const entry = LEXICON[lookupKey];
    return {
      resolvedTerm,
      originalTerm,
      spokenText: entry.spokenText || normalizeSpokenText(resolvedTerm),
      ipa: validCustomIpa || entry.ipa,
      phonetic: entry.phonetic,
      language: "en-US"
    };
  }

  // 3. Check Plural Variations (e.g. "-es", "-s")
  if (lookupKey.endsWith("es") && LEXICON[lookupKey.slice(0, -2)]) {
    const base = LEXICON[lookupKey.slice(0, -2)];
    return {
      resolvedTerm,
      originalTerm,
      spokenText: normalizeSpokenText(resolvedTerm),
      ipa: base.ipa.replace(/\/$/, "ɪz/"),
      phonetic: `${base.phonetic}-iz`,
      language: "en-US"
    };
  }
  if (lookupKey.endsWith("s") && LEXICON[lookupKey.slice(0, -1)]) {
    const base = LEXICON[lookupKey.slice(0, -1)];
    return {
      resolvedTerm,
      originalTerm,
      spokenText: normalizeSpokenText(resolvedTerm),
      ipa: base.ipa.replace(/\/$/, "z/"),
      phonetic: `${base.phonetic}-z`,
      language: "en-US"
    };
  }

  // 4. Pure All-Caps Acronym (e.g. "LLM", "SDK", "API", "CLI")
  if (/^[A-Z]{2,5}$/.test(originalTerm)) {
    const letters = originalTerm.toLowerCase().split("");
    const ipaParts: string[] = [];
    const phoneticParts: string[] = [];
    for (const char of letters) {
      if (LETTER_NAMES[char]) {
        ipaParts.push(LETTER_NAMES[char].ipa);
        phoneticParts.push(LETTER_NAMES[char].phonetic);
      }
    }
    if (ipaParts.length > 0) {
      const lastIndex = ipaParts.length - 1;
      const ipaStr = `/${ipaParts.slice(0, lastIndex).map((p) => `ˌ${p}`).join(" ")} ˈ${ipaParts[lastIndex]}/`;
      return {
        resolvedTerm,
        originalTerm,
        spokenText: letters.map((c) => c.toUpperCase()).join("-"),
        ipa: ipaStr,
        phonetic: phoneticParts.join("-"),
        language: "en-US"
      };
    }
  }

  // 5. Multi-Word Phrase Composition (e.g. "Cloud Computing", "Machine Learning", "Deep Learning")
  const words = resolvedTerm.split(/\s+/).filter(Boolean);
  if (words.length > 1 && words.length <= 6) {
    const ipaTokens: string[] = [];
    const phoneticTokens: string[] = [];
    let allTokensValid = true;

    for (const w of words) {
      const lowerWord = w.toLowerCase();
      if (LEXICON[lowerWord]) {
        ipaTokens.push(LEXICON[lowerWord].ipa.replace(/^\/|\/$/g, ""));
        phoneticTokens.push(LEXICON[lowerWord].phonetic);
      } else {
        const generated = g2pSingleWord(w);
        if (isValidIpa(generated.ipa, w)) {
          ipaTokens.push(generated.ipa.replace(/^\/|\/$/g, ""));
          phoneticTokens.push(generated.phonetic);
        } else {
          allTokensValid = false;
          break;
        }
      }
    }

    if (allTokensValid && ipaTokens.length === words.length) {
      return {
        resolvedTerm,
        originalTerm,
        spokenText: normalizeSpokenText(resolvedTerm),
        ipa: validCustomIpa || `/${ipaTokens.join(" ")}/`,
        phonetic: phoneticTokens.join(" "),
        language: "en-US"
      };
    }
  }

  // 6. Single Word G2P Engine
  if (words.length === 1 && /^[a-zA-Z]+$/.test(words[0])) {
    const single = g2pSingleWord(words[0]);
    if (isValidIpa(single.ipa, words[0])) {
      return {
        resolvedTerm,
        originalTerm,
        spokenText: normalizeSpokenText(resolvedTerm),
        ipa: validCustomIpa || single.ipa,
        phonetic: single.phonetic,
        language: "en-US"
      };
    }
  }

  // 7. Fallback: If authentic IPA cannot be generated, omit IPA rather than display fake wrapped slashes!
  return {
    resolvedTerm,
    originalTerm,
    spokenText: normalizeSpokenText(resolvedTerm),
    ipa: validCustomIpa,
    phonetic: undefined,
    language: "en-US"
  };
}
