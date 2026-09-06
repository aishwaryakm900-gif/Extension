import {
  cleanSelection,
  classifySelection,
  resolveSelectionCandidate,
  extractTokensFromText,
  isMeaningfulWord,
  isTechnicalToken
} from "../lib/reading-context.ts";

function runTests() {
  console.log("=== RUNNING USER-SPECIFIED TEST CASES ===\n");

  let passed = 0;
  let total = 0;

  function assert(condition, testName, detail = "") {
    total++;
    if (condition) {
      console.log(`[PASS] ${testName}`);
      passed++;
    } else {
      console.error(`[FAIL] ${testName} -> ${detail}`);
    }
  }

  const programmingContext = "Programming Languages: Java, Python, C, C++, JavaScript, SQL";

  // TEST 1: Page "Python, C, C++, JavaScript, SQL", select JavaScript -> JavaScript, NOT "++, JavaS"
  const t1 = resolveSelectionCandidate("JavaScript", "", "", programmingContext);
  assert(
    t1.originalSelection === "JavaScript" && t1.resolvedSelection === "JavaScript" && t1.selectionType === "word",
    "TEST 1: Select 'JavaScript' -> returns exact 'JavaScript'",
    JSON.stringify(t1)
  );

  // TEST 2: Select C++ -> C++, NOT "++"
  const t2 = resolveSelectionCandidate("C++", "", "", programmingContext);
  assert(
    t2.originalSelection === "C++" && t2.resolvedSelection === "C++" && t2.selectionType === "word",
    "TEST 2: Select 'C++' -> preserves 'C++', not stripped",
    JSON.stringify(t2)
  );

  // TEST 3: Select Python -> Python
  const t3 = resolveSelectionCandidate("Python", "", "", programmingContext);
  assert(
    t3.originalSelection === "Python" && t3.resolvedSelection === "Python" && t3.selectionType === "word",
    "TEST 3: Select 'Python' -> returns 'Python'",
    JSON.stringify(t3)
  );

  // TEST 4: Select JavaS -> resolves JavaScript
  const t4 = resolveSelectionCandidate("JavaS", "", "", programmingContext);
  assert(
    t4.resolvedSelection === "JavaScript" && t4.selectionType === "partial-word" && t4.isPartial === true,
    "TEST 4: Select 'JavaS' -> recovers 'JavaScript'",
    JSON.stringify(t4)
  );

  // TEST 5: Select congratulat from congratulations -> congratulations
  const t5 = resolveSelectionCandidate("congratulat", "", "", "Her heartfelt congratulations were appreciated.");
  assert(
    t5.resolvedSelection === "congratulations" && t5.selectionType === "partial-word",
    "TEST 5: Select 'congratulat' -> recovers 'congratulations'",
    JSON.stringify(t5)
  );

  // TEST 6: Select night -> night
  const t6 = resolveSelectionCandidate("night", "", "", "It was a dark night.");
  assert(
    t6.resolvedSelection === "night" && t6.selectionType === "word" && !t6.isPartial,
    "TEST 6: Select 'night' -> exact 'night' preserved",
    JSON.stringify(t6)
  );

  // TEST 7: Select melancholy -> melancholy
  const t7 = resolveSelectionCandidate("melancholy", "", "", "His melancholy songs echoed through the room.");
  assert(
    t7.resolvedSelection === "melancholy" && t7.selectionType === "word" && !t7.isPartial,
    "TEST 7: Select 'melancholy' -> valid word not overcorrected",
    JSON.stringify(t7)
  );

  // TEST 8a: Select punctuation "++" in unrelated context -> unknown / not a valid word
  const t8a = resolveSelectionCandidate("++", "", "", "The count is ++ value.");
  assert(
    t8a.selectionType === "unknown" && t8a.confidence === "low",
    "TEST 8a: Pure punctuation '++' in unrelated context is not a word",
    JSON.stringify(t8a)
  );

  // TEST 8b: Select "++" with attached prefix "C" or in C++ context -> recovers C++
  const t8b = resolveSelectionCandidate("++", "C", "", programmingContext);
  assert(
    t8b.resolvedSelection === "C++" && t8b.selectionType === "word",
    "TEST 8b: '++' in C++ context recovers 'C++'",
    JSON.stringify(t8b)
  );

  // TEST 9: Select "++, JavaS" -> recovers JavaScript, NOT "++, JavaS"
  const t9 = resolveSelectionCandidate("++, JavaS", "", "", programmingContext);
  assert(
    t9.originalSelection === "++, JavaS" &&
    t9.resolvedSelection === "JavaScript" &&
    t9.selectionType === "partial-word" &&
    t9.isPartial === true,
    "TEST 9: Select '++, JavaS' -> recovers 'JavaScript', preserves original '++, JavaS'",
    JSON.stringify(t9)
  );

  // TEST 10: Select a complete sentence -> exact sentence preserved
  const fullSentence = "Now that he knew exactly how much I had to depend on him, he stopped hiding his lifestyle.";
  const t10 = resolveSelectionCandidate(fullSentence, "", "", fullSentence);
  assert(
    t10.resolvedSelection === fullSentence && t10.selectionType === "sentence",
    "TEST 10: Select complete sentence -> exact sentence preserved",
    JSON.stringify(t10)
  );

  // Additional Technical Tokens
  const techTokens = ["Node.js", "Next.js", ".NET", "TypeScript", "C#", "SQL"];
  for (const token of techTokens) {
    const res = resolveSelectionCandidate(token, "", "", `Learning ${token} today.`);
    assert(
      res.resolvedSelection === token && res.selectionType === "word",
      `Technical token: '${token}' preserved as word`,
      JSON.stringify(res)
    );
  }

  // Idiomatic Phrase
  const phrase = "hit the roof";
  const tPhrase = resolveSelectionCandidate(phrase, "", "", `He will hit the roof when he hears this.`);
  assert(
    tPhrase.resolvedSelection === phrase && tPhrase.selectionType === "phrase",
    "Idiom phrase 'hit the roof' preserved as phrase",
    JSON.stringify(tPhrase)
  );

  // === NEW TESTS FOR PATIENT REGISTRATION REQUIREMENT ===
  const patientContext = "Developed ABHA+, an AI-powered multilingual healthcare platform with voice-assisted patient registration, AI-powered OPD token generation, and intelligent healthcare workflows.";

  // PATIENT REG TEST 1: Select only 'registration' -> returns exact 'registration'
  const pr1 = resolveSelectionCandidate("registration", "", "", patientContext);
  assert(
    pr1.originalSelection === "registration" && pr1.resolvedSelection === "registration" && pr1.selectionType === "word",
    "PATIENT REG TEST 1: Select 'registration' -> exact 'registration', NOT 'ient registr'",
    JSON.stringify(pr1)
  );

  // PATIENT REG TEST 2: Select 'patient' -> returns 'patient'
  const pr2 = resolveSelectionCandidate("patient", "", "", patientContext);
  assert(
    pr2.originalSelection === "patient" && pr2.resolvedSelection === "patient" && pr2.selectionType === "word",
    "PATIENT REG TEST 2: Select 'patient' -> exact 'patient'",
    JSON.stringify(pr2)
  );

  // PATIENT REG TEST 3: Select 'patient registration' -> exact 'patient registration'
  const pr3 = resolveSelectionCandidate("patient registration", "", "", patientContext);
  assert(
    pr3.originalSelection === "patient registration" && pr3.resolvedSelection === "patient registration" && pr3.selectionType === "phrase",
    "PATIENT REG TEST 3: Select 'patient registration' -> exact 'patient registration'",
    JSON.stringify(pr3)
  );

  // PATIENT REG TEST 4: Select complete sentence containing registration
  const pr4 = resolveSelectionCandidate(patientContext, "", "", patientContext);
  assert(
    pr4.resolvedSelection === patientContext && pr4.selectionType === "sentence",
    "PATIENT REG TEST 4: Select complete sentence containing registration -> exact sentence",
    JSON.stringify(pr4)
  );

  // PATIENT REG TEST 5: Partial word 'registr' -> recovers 'registration'
  const pr5 = resolveSelectionCandidate("registr", "", "", patientContext);
  assert(
    pr5.originalSelection === "registr" && pr5.resolvedSelection === "registration" && pr5.selectionType === "partial-word",
    "PATIENT REG TEST 5: Select partial word 'registr' -> recovers 'registration'",
    JSON.stringify(pr5)
  );

  // PATIENT REG TEST 6: Corrupted boundary slice 'ient registr' -> recovers 'registration'
  const pr6 = resolveSelectionCandidate("ient registr", "pat", "ation", patientContext);
  assert(
    pr6.originalSelection === "ient registr" && pr6.resolvedSelection === "registration" && pr6.selectionType === "partial-word",
    "PATIENT REG TEST 6: Corrupted 'ient registr' -> recovers 'registration' without sending 'ient registr'",
    JSON.stringify(pr6)
  );

  console.log(`\nResults: ${passed}/${total} passed.`);
  if (passed !== total) process.exit(1);
}

runTests();
