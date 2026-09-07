import assert from "node:assert";
import { buildSync } from "esbuild";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const tempDir = resolve(__dirname, "../.cache");
mkdirSync(tempDir, { recursive: true });
const tempBundlePron = resolve(tempDir, "pronunciation-test-bundle.mjs");
const tempBundleContext = resolve(tempDir, "reading-context-test-bundle.mjs");

// Build bundle from lib/pronunciation.ts
buildSync({
  entryPoints: [resolve(__dirname, "../lib/pronunciation.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  outfile: tempBundlePron
});

// Build bundle from lib/reading-context.ts
buildSync({
  entryPoints: [resolve(__dirname, "../lib/reading-context.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  outfile: tempBundleContext
});

const {
  resolvePronunciation,
  isEligibleForPronunciation,
  isValidIpa,
  getSpokenText,
  splitCamelCase,
  isCamelCase,
  normalizePronunciationTarget
} = await import(pathToFileURL(tempBundlePron).href);

const {
  resolveSelectionCandidate,
  isMeaningfulWord
} = await import(pathToFileURL(tempBundleContext).href);

function runTests() {
  console.log("==================================================");
  console.log("RUNNING READER AI GENERIC PRONUNCIATION SUITE");
  console.log("==================================================\n");

  let passed = 0;
  let total = 0;

  function test(name, fn) {
    total++;
    try {
      fn();
      console.log(`[PASS] ${name}`);
      passed++;
    } catch (e) {
      console.error(`[FAIL] ${name} ->`, e.message);
    }
  }

  // 1. NORMAL WORDS
  const normalWords = [
    { word: "national", expectedIpa: "/ˈnæʃənəl/", expectedSounds: "NASH-uh-nuhl" },
    { word: "management", expectedIpa: "/ˈmænɪdʒmənt/", expectedSounds: "MAN-ij-muhnt" },
    { word: "yourself", expectedIpa: "/jɔːrˈsɛlf/", expectedSounds: "yor-SELF" },
    { word: "melancholy", expectedIpa: "/ˈmɛlənˌkɑːli/", expectedSounds: "MEL-uhn-koll-ee" },
    { word: "registration", expectedIpa: "/ˌrɛdʒɪˈstreɪʃən/", expectedSounds: "rej-ih-STRAY-shuhn" },
    { word: "congratulations", expectedIpa: "/kənˌɡrætʃəˈleɪʃənz/", expectedSounds: "kuhn-grat-shuh-LAY-shuhnz" },
    { word: "stretches", expectedIpa: "/ˈstrɛtʃɪz/", expectedSounds: "STRETCH-iz" }
  ];

  console.log("--- 1. NORMAL WORDS ---");
  for (const item of normalWords) {
    test(`Normal word "${item.word}"`, () => {
      assert(isEligibleForPronunciation(item.word, "word"), "Should be eligible");
      const res = resolvePronunciation(item.word);
      assert(res !== null, "Result should not be null");
      assert.strictEqual(res.resolvedTerm, item.word);
      assert.strictEqual(res.ipa, item.expectedIpa);
      assert.strictEqual(res.phonetic, item.expectedSounds);
      assert.strictEqual(res.spokenText, item.word);
      assert(isValidIpa(res.ipa, item.word), "IPA must be valid");
    });
  }

  // 2. CAMELCASE
  console.log("\n--- 2. CAMELCASE HANDLING ---");
  const camelCases = [
    { term: "CloudComputing", expectedResolved: "Cloud Computing", expectedSpoken: "Cloud Computing" },
    { term: "MachineLearning", expectedResolved: "Machine Learning", expectedSpoken: "Machine Learning" },
    { term: "StateManagement", expectedResolved: "State Management", expectedSpoken: "State Management" }
  ];

  for (const item of camelCases) {
    test(`CamelCase "${item.term}" -> "${item.expectedResolved}"`, () => {
      assert(isCamelCase(item.term), "Should detect CamelCase");
      assert.strictEqual(splitCamelCase(item.term), item.expectedResolved);
      assert.strictEqual(normalizePronunciationTarget(item.term), item.expectedResolved);

      const res = resolvePronunciation(item.term);
      assert(res !== null, "Result should not be null");
      assert.strictEqual(res.originalTerm, item.term, "Original text preserved internally");
      assert.strictEqual(res.resolvedTerm, item.expectedResolved, "Resolved text normalized");
      assert.strictEqual(res.spokenText, item.expectedSpoken, "TTS target spoken");
      assert(res.ipa && res.ipa.startsWith("/") && res.ipa.endsWith("/"), "Must have real IPA");
      assert(res.phonetic && res.phonetic.length > 0, "Must have readable guide");
      assert(!res.ipa.toLowerCase().includes("cloudcomputing"), "IPA must not be raw text wrapped in slashes");
      assert(isValidIpa(res.ipa, item.term), "IPA must be genuine sounds");
    });
  }

  // 3. TECHNICAL TERMS
  console.log("\n--- 3. TECHNICAL TERMS ---");
  const techTerms = [
    { term: "JavaScript", expectedSpoken: "JavaScript" },
    { term: "TypeScript", expectedSpoken: "TypeScript" },
    { term: "Python", expectedSpoken: "Python" },
    { term: "React", expectedSpoken: "React" },
    { term: "Node.js", expectedSpoken: "Node J S" },
    { term: "Next.js", expectedSpoken: "Next J S" },
    { term: "OpenCV", expectedSpoken: "Open C V" },
    { term: "TensorFlow", expectedSpoken: "TensorFlow" }
  ];

  for (const item of techTerms) {
    test(`Tech term "${item.term}"`, () => {
      const res = resolvePronunciation(item.term);
      assert(res !== null, "Result should not be null");
      assert.strictEqual(res.spokenText, item.expectedSpoken, `Spoken text should be ${item.expectedSpoken}`);
      assert(res.ipa && isValidIpa(res.ipa, item.term), "IPA must be valid");
      assert(res.phonetic && res.phonetic.length > 0, "Readable phonetic must exist");
      // Verify TTS never receives raw IPA characters
      assert(!/[ˈˌːæɑɔɛɪʊʌəʃʒθðŋ]/.test(res.spokenText), `Spoken text "${res.spokenText}" must NOT contain IPA phonetic characters`);
    });
  }

  // 4. ACRONYMS & SYMBOL TERMS
  console.log("\n--- 4. ACRONYMS & SYMBOLS ---");
  const specialTerms = [
    { term: "REST API", expectedSpoken: "R-E-S-T A-P-I" },
    { term: "RAG", expectedSpoken: "R-A-G" },
    { term: "LLM", expectedSpoken: "L-L-M" },
    { term: "C++", expectedSpoken: "C plus plus", expectedIpa: "/ˌsiː plʌs ˈplʌs/" },
    { term: "C#", expectedSpoken: "C sharp", expectedIpa: "/ˌsiː ˈʃɑːrp/" },
    { term: ".NET", expectedSpoken: "dot net", expectedIpa: "/ˌdɑːt ˈnɛt/" }
  ];

  for (const item of specialTerms) {
    test(`Special/Symbol term "${item.term}" -> speaks "${item.expectedSpoken}"`, () => {
      const res = resolvePronunciation(item.term);
      assert(res !== null, "Result should not be null");
      assert.strictEqual(res.spokenText, item.expectedSpoken);
      assert(res.ipa && isValidIpa(res.ipa, item.term), "IPA must be valid");
      if (item.expectedIpa) {
        assert.strictEqual(res.ipa, item.expectedIpa);
      }
      assert(res.phonetic && res.phonetic.length > 0, "Readable guide must exist");
    });
  }

  // 5. PHRASES
  console.log("\n--- 5. PHRASES ---");
  const phrases = [
    "machine learning",
    "artificial intelligence",
    "large language model",
    "retrieval augmented generation"
  ];

  for (const phrase of phrases) {
    test(`Phrase "${phrase}" composed as single card`, () => {
      assert(isEligibleForPronunciation(phrase, "phrase"), "Phrase should be eligible");
      const res = resolvePronunciation(phrase);
      assert(res !== null, "Result should not be null");
      assert.strictEqual(res.resolvedTerm, phrase);
      assert.strictEqual(res.spokenText, phrase);
      assert(res.ipa && res.ipa.startsWith("/") && res.ipa.endsWith("/"), "Must have compound IPA");
      assert(isValidIpa(res.ipa, phrase), "Compound IPA must be authentic");
      assert(res.phonetic && res.phonetic.includes(" "), "Compound phonetic must encompass all words");
    });
  }

  // 6. DYNAMIC G2P RULE FALLBACK (Unlisted arbitrary words)
  console.log("\n--- 6. DYNAMIC G2P RULE ENGINE FOR UNLISTED WORDS ---");
  const arbitraryWords = [
    "computation",
    "microcontroller",
    "unpredictable",
    "hyperparameter"
  ];

  for (const word of arbitraryWords) {
    test(`Dynamic G2P fallback for unlisted word "${word}"`, () => {
      const res = resolvePronunciation(word);
      assert(res !== null, "Result should generate dynamically");
      assert(res.ipa && res.ipa.startsWith("/") && res.ipa.endsWith("/"), "Must produce valid slash IPA");
      assert(isValidIpa(res.ipa, word), "Must not be fake wrapped text");
      assert(res.phonetic && res.phonetic.length > 0, "Must produce readable phonetic guide");
      assert.strictEqual(res.spokenText, word, "TTS target should be the word");
    });
  }

  // 7. NEGATIVE TESTS: REJECT FAKE IPA
  console.log("\n--- 7. NEGATIVE TESTS: REJECT FAKE IPA ---");
  const fakeCases = [
    { term: "cloudcomputing", ipa: "/cloudcomputing/" },
    { term: "management", ipa: "/management/" },
    { term: "national", ipa: "/national/" },
    { term: "arbitrary", ipa: "/arbitrary/" }
  ];

  for (const fake of fakeCases) {
    test(`Fake IPA check: "${fake.ipa}" for "${fake.term}" is rejected`, () => {
      assert.strictEqual(isValidIpa(fake.ipa, fake.term), false, "Must reject plain text wrapped in slashes");
    });
  }

  // 8. NEGATIVE TESTS: SELECTION LENGTH THRESHOLD
  console.log("\n--- 8. SELECTION LENGTH & TYPE THRESHOLDS ---");
  test("Long sentence (> 5 words) is NOT eligible for pronunciation", () => {
    assert.strictEqual(
      isEligibleForPronunciation("This is an extraordinarily long sentence that should not display pronunciation.", "sentence"),
      false
    );
  });

  test("Passage selection is NOT eligible for pronunciation", () => {
    assert.strictEqual(
      isEligibleForPronunciation("Short passage", "passage"),
      false
    );
  });

  test("Long text (> 60 characters) is NOT eligible for pronunciation", () => {
    assert.strictEqual(
      isEligibleForPronunciation("a".repeat(65), "word"),
      false
    );
  });

  // 9. MID-WORD RESOLUTION IN NOVEL/LARGE PDF CONTEXTS
  console.log("\n--- 9. MID-WORD SELECTIONS & NOVEL PDF RESOLUTION ---");
  const midWordScenarios = [
    {
      name: "Mid-word 'ello' inside 'hello'",
      rawSelection: "ello",
      prefixAttached: "h",
      suffixAttached: "",
      context: "She smiled and said hello to everyone in the room.",
      expectedResolved: "hello"
    },
    {
      name: "Mid-word 'ello' resolved via surrounding sentence context",
      rawSelection: "ello",
      prefixAttached: "",
      suffixAttached: "",
      context: "She smiled and said hello to everyone in the room.",
      expectedResolved: "hello"
    },
    {
      name: "Partial 'registr' inside 'patient registration form'",
      rawSelection: "registr",
      prefixAttached: "",
      suffixAttached: "ation",
      context: "Please complete the registration form before your visit.",
      expectedResolved: "registration"
    },
    {
      name: "Partial 'registr' resolved via sentence token",
      rawSelection: "registr",
      prefixAttached: "",
      suffixAttached: "",
      context: "Please complete the registration form before your visit.",
      expectedResolved: "registration"
    },
    {
      name: "Suffix fragment 'ational' inside 'national'",
      rawSelection: "ational",
      prefixAttached: "n",
      suffixAttached: "",
      context: "The national park was founded in 1919.",
      expectedResolved: "national"
    },
    {
      name: "Suffix fragment 'ational' resolved via sentence token",
      rawSelection: "ational",
      prefixAttached: "",
      suffixAttached: "",
      context: "The national park was founded in 1919.",
      expectedResolved: "national"
    },
    {
      name: "Technical fragment 'JavaS' in web context",
      rawSelection: "JavaS",
      prefixAttached: "",
      suffixAttached: "cript",
      context: "Modern web applications use JavaScript for front-end logic.",
      expectedResolved: "JavaScript"
    },
    {
      name: "Technical fragment 'JavaS' resolved via sentence token",
      rawSelection: "JavaS",
      prefixAttached: "",
      suffixAttached: "",
      context: "Modern web applications use JavaScript for front-end logic.",
      expectedResolved: "JavaScript"
    },
    {
      name: "Technical fragment 'TypeScr' in compiler context",
      rawSelection: "TypeScr",
      prefixAttached: "",
      suffixAttached: "",
      context: "The TypeScript compiler checks types at build time.",
      expectedResolved: "TypeScript"
    },
    {
      name: "Compound fragment 'CloudComput' resolved cleanly",
      rawSelection: "CloudComput",
      prefixAttached: "",
      suffixAttached: "ing",
      context: "Enterprise CloudComputing platforms require high availability.",
      expectedResolved: "CloudComputing"
    }
  ];

  for (const item of midWordScenarios) {
    test(item.name, () => {
      const candidate = resolveSelectionCandidate(
        item.rawSelection,
        item.prefixAttached,
        item.suffixAttached,
        item.context
      );
      assert.strictEqual(
        candidate.resolvedSelection.toLowerCase(),
        item.expectedResolved.toLowerCase(),
        `Expected resolvedSelection to be "${item.expectedResolved}", got "${candidate.resolvedSelection}"`
      );

      // Now test pronunciation on the resolved candidate
      const target = candidate.resolvedSelection;
      assert(isEligibleForPronunciation(target, candidate.selectionType), "Resolved term must be eligible");

      const pron = resolvePronunciation(target);
      assert(pron !== null, "Pronunciation must not be null");
      assert(pron.ipa && isValidIpa(pron.ipa, target), "Pronunciation must have valid authentic IPA");
      assert(pron.spokenText && pron.spokenText.length > 0, "Spoken text must exist");
      // TTS must never receive the raw fragment
      assert.notStrictEqual(pron.spokenText.toLowerCase(), item.rawSelection.toLowerCase());
      // TTS must never receive IPA characters
      assert(!/[ˈˌːæɑɔɛɪʊʌəʃʒθðŋ]/.test(pron.spokenText), "Spoken text must be natural word, not IPA");
    });
  }

  // 10. PIPELINE VALIDATION & PRESERVING ORIGINAL SELECTION
  console.log("\n--- 10. SEPARATE FIELD PRESERVATION & LARGE PDF PERFORMANCE ---");
  test("Separation of rawSelection, resolvedTerm, and pronunciationTarget", () => {
    const rawSelection = "ello";
    const candidate = resolveSelectionCandidate("ello", "h", "", "hello world");
    const resolvedTerm = candidate.resolvedSelection;
    const pron = resolvePronunciation(resolvedTerm);

    assert.strictEqual(candidate.originalSelection, "ello", "Raw selection must be preserved");
    assert.strictEqual(resolvedTerm, "hello", "Resolved term must be full word");
    assert.strictEqual(pron.resolvedTerm, "hello", "Pronunciation target must be resolved term");
    assert.strictEqual(pron.spokenText, "hello", "TTS text must be natural spoken word");
    assert.strictEqual(pron.ipa, "/həˈloʊ/", "IPA must be accurate");
  });

  test("Large novel PDF: TTS text receives ONLY the single word, never novel text", () => {
    const novelParagraph = "In the melancholy days of autumn, when the leaves were falling from the great oaks, the traveller arrived at the old manor house after walking through miles of dreary moors.";
    const candidate = resolveSelectionCandidate("melancholy", "", "", novelParagraph);
    const pron = resolvePronunciation(candidate.resolvedSelection);

    assert.strictEqual(pron.spokenText, "melancholy", "TTS text must be only 'melancholy'");
    assert(pron.spokenText.length < 20, "TTS text must not contain surrounding novel text");
    assert.strictEqual(pron.ipa, "/ˈmɛlənˌkɑːli/");
  });

  // 11. REJECTION OF UNRESOLVABLE CORRUPTED FRAGMENTS
  console.log("\n--- 11. REJECTION OF AMBIGUOUS / CORRUPTED FRAGMENTS ---");
  test("Ambiguous fragment without surrounding evidence is marked unknown", () => {
    const candidate = resolveSelectionCandidate("xyzq", "", "", "some unrelated text without matching tokens");
    assert.strictEqual(candidate.selectionType, "unknown", "Must reject ambiguous fragment");
    assert.strictEqual(isEligibleForPronunciation("xyzq", candidate.selectionType), false, "Must not be eligible for TTS");
  });

  test("Punctuation-only selection is marked unknown and not eligible", () => {
    const candidate = resolveSelectionCandidate("...", "", "", "sentence ending...");
    assert.strictEqual(candidate.selectionType, "unknown");
    assert.strictEqual(isEligibleForPronunciation("...", candidate.selectionType), false);
  });

  console.log(`\n==================================================`);
  console.log(`TEST SUMMARY: ${passed}/${total} assertions passed`);
  console.log(`==================================================\n`);

  if (passed !== total) {
    process.exit(1);
  }
}

runTests();
