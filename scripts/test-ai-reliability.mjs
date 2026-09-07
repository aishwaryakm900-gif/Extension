import assert from "node:assert";

async function runTests() {
  console.log("=== RUNNING LIVE API EXPLAIN & RELIABILITY TESTS ===\n");
  let passed = 0;
  let total = 0;

  async function test(name, fn) {
    total++;
    try {
      await fn();
      console.log(`[PASS] ${name}`);
      passed++;
    } catch (e) {
      console.error(`[FAIL] ${name} ->`, e.message);
    }
  }

  const BASE_URL = "http://localhost:3000/api/explain";

  // TEST 1: OPTIONS CORS Preflight
  await test("OPTIONS /api/explain: Returns 204 with CORS headers", async () => {
    const res = await fetch(BASE_URL, { method: "OPTIONS" });
    assert.strictEqual(res.status, 204);
    assert.strictEqual(res.headers.get("access-control-allow-origin"), "*");
  });

  // TEST 2: Invalid JSON body
  await test("POST /api/explain: Invalid JSON body returns HTTP 400", async () => {
    const res = await fetch(BASE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json"
    });
    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.strictEqual(data.code, "INVALID_JSON");
  });

  // TEST 3: Validation failure on missing fields
  await test("POST /api/explain: Missing required fields returns HTTP 400", async () => {
    const res = await fetch(BASE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selectionType: "invalid" })
    });
    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.strictEqual(data.code, "VALIDATION_FAILED");
  });

  // TEST 4: Live Explanation for 'management'
  await test("POST /api/explain: Real explanation for word 'management' returns HTTP 200 with valid schema", async () => {
    const res = await fetch(BASE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        selectedText: "management",
        resolvedSelection: "management",
        selectionType: "word",
        sentence: "Education Ballari Institute of Technology and Management (BITM), Ballari was founded in 1997.",
        paragraph: "Education Ballari Institute of Technology and Management (BITM), Ballari was founded in 1997.",
        context: "Education Ballari Institute of Technology and Management (BITM), Ballari was founded in 1997.",
        pageTitle: "BITM Overview",
        sourceType: "webpage",
        sourceUrl: "https://bitm.edu.in"
      })
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.type, "word");
    assert(data.word && data.word.toLowerCase() === "management", `Word should be management, got ${data.word}`);
    assert(typeof data.meaning === "string" && data.meaning.length > 0, "Meaning must be non-empty");
    assert(typeof data.contextExplanation === "string", "contextExplanation must be present");
    console.log("   [Explain Output for 'management']:\n", JSON.stringify(data, null, 2));
  });

  // TEST 5: Live Explanation for 'yourself'
  await test("POST /api/explain: Real explanation for word 'yourself' returns HTTP 200 with valid schema", async () => {
    const res = await fetch(BASE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        selectedText: "yourself",
        resolvedSelection: "yourself",
        selectionType: "word",
        sentence: "You have to believe in yourself when nobody else does.",
        paragraph: "You have to believe in yourself when nobody else does.",
        context: "You have to believe in yourself when nobody else does.",
        pageTitle: "Inspirational Quotes",
        sourceType: "webpage",
        sourceUrl: "https://example.com"
      })
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.type, "word");
    assert(data.word && data.word.toLowerCase() === "yourself");
    assert(typeof data.meaning === "string" && data.meaning.length > 0);
    console.log("   [Explain Output for 'yourself']:\n", JSON.stringify(data, null, 2));
  });

  // TEST 6: Partial word resolution 'registr' -> 'registration'
  await test("POST /api/explain: Partial word 'registr' resolved to 'registration'", async () => {
    const res = await fetch(BASE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        originalSelection: "registr",
        selectedText: "registration",
        resolvedSelection: "registration",
        selectionType: "partial-word",
        sentence: "Patient registration must be completed before consultation.",
        paragraph: "Patient registration must be completed before consultation.",
        context: "Patient registration must be completed before consultation.",
        pageTitle: "Clinic Intake",
        sourceType: "pdf",
        sourceUrl: "http://localhost:3000/reader/pdf"
      })
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.type, "word");
    assert(data.word && data.word.toLowerCase() === "registration");
    console.log("   [Explain Output for 'registration']:\n", JSON.stringify(data, null, 2));
  });

  // TEST 7: Technical word 'C++'
  await test("POST /api/explain: Technical token 'C++'", async () => {
    const res = await fetch(BASE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        selectedText: "C++",
        resolvedSelection: "C++",
        selectionType: "word",
        sentence: "The core graphics engine is written in C++ for maximum performance.",
        paragraph: "The core graphics engine is written in C++ for maximum performance.",
        context: "The core graphics engine is written in C++ for maximum performance.",
        pageTitle: "Tech Stack",
        sourceType: "webpage",
        sourceUrl: "https://example.com"
      })
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.type, "word");
    console.log("   [Explain Output for 'C++']:\n", JSON.stringify(data, null, 2));
  });

  console.log(`\nResults: ${passed}/${total} passed.\n`);
  if (passed !== total) process.exit(1);
}

runTests();
