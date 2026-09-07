// Verification test for Reader AI popup sizing, positioning, dynamic max-height, and internal scrolling
import assert from "node:assert";

// Simulation of the exact positionPopup algorithm implemented in content.ts and pdf-reader.ts
const POPUP_WIDTH = 320;
const VIEWPORT_MARGIN = 16;
const SELECTION_GAP = 8;
const MAX_POPUP_HEIGHT = 650;

function simulatePositionPopup({
  selectionRect,
  viewportWidth,
  viewportHeight,
  naturalContentHeight
}) {
  const width = POPUP_WIDTH;
  const naturalHeight = naturalContentHeight;

  // 1. Horizontal positioning
  const selectionCenter = selectionRect.left + selectionRect.width / 2;
  const targetLeft = selectionCenter - width / 2;
  const maxLeft = Math.max(VIEWPORT_MARGIN, viewportWidth - width - VIEWPORT_MARGIN);
  const popupLeft = Math.max(VIEWPORT_MARGIN, Math.min(targetLeft, maxLeft));

  // 2. Vertical available space
  const spaceBelow = viewportHeight - selectionRect.bottom - SELECTION_GAP - VIEWPORT_MARGIN;
  const spaceAbove = selectionRect.top - SELECTION_GAP - VIEWPORT_MARGIN;

  let placeBelow;
  let availableSpace;

  if (spaceBelow >= naturalHeight) {
    placeBelow = true;
    availableSpace = spaceBelow;
  } else if (spaceAbove >= naturalHeight) {
    placeBelow = false;
    availableSpace = spaceAbove;
  } else {
    if (spaceBelow >= spaceAbove) {
      placeBelow = true;
      availableSpace = spaceBelow;
    } else {
      placeBelow = false;
      availableSpace = spaceAbove;
    }
  }

  const calculatedMaxHeight = Math.max(120, Math.min(availableSpace, MAX_POPUP_HEIGHT));
  // Rendered height of the popup constrained by calculatedMaxHeight
  const renderedHeight = Math.min(naturalHeight, calculatedMaxHeight);

  let popupTop;
  if (placeBelow) {
    popupTop = selectionRect.bottom + SELECTION_GAP;
  } else {
    popupTop = selectionRect.top - SELECTION_GAP - renderedHeight;
  }

  const clampedTop = Math.max(
    VIEWPORT_MARGIN,
    Math.min(popupTop, Math.max(VIEWPORT_MARGIN, viewportHeight - renderedHeight - VIEWPORT_MARGIN))
  );

  const isScrollable = naturalHeight > calculatedMaxHeight;

  return {
    left: Math.round(popupLeft),
    top: Math.round(clampedTop),
    renderedHeight,
    calculatedMaxHeight,
    placeBelow,
    isScrollable,
    bottom: Math.round(clampedTop) + renderedHeight,
    right: Math.round(popupLeft) + width
  };
}

function runSuite() {
  console.log("=== RUNNING POPUP SCROLLING & POSITIONING TESTS ===\n");
  let passed = 0;
  let total = 0;

  function test(name, fn) {
    total++;
    try {
      fn();
      console.log(`[PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`[FAIL] ${name} ->`, err.message);
    }
  }

  // TEST 1: Short word ("night") in standard viewport
  test("TEST 1: Short word ('night', 160px content) stays compact and unscrollable", () => {
    const res = simulatePositionPopup({
      selectionRect: { left: 400, top: 200, right: 450, bottom: 220, width: 50, height: 20 },
      viewportWidth: 1200,
      viewportHeight: 800,
      naturalContentHeight: 160
    });
    assert.strictEqual(res.placeBelow, true);
    assert.strictEqual(res.renderedHeight, 160, "Height should stay compact at 160px");
    assert.strictEqual(res.isScrollable, false, "Should not need scrolling when content fits");
    assert(res.bottom <= 800 - VIEWPORT_MARGIN, "Popup must be within viewport bottom");
    assert(res.top >= VIEWPORT_MARGIN, "Popup must be within viewport top");
  });

  // TEST 2: Long word ("stretches") with MEANING, CONTEXT, EXAMPLE, KEY POINTS (850px natural height)
  test("TEST 2: Long word ('stretches', 850px content) is clamped to max-height and internally scrollable", () => {
    const res = simulatePositionPopup({
      selectionRect: { left: 400, top: 100, right: 480, bottom: 120, width: 80, height: 20 },
      viewportWidth: 1200,
      viewportHeight: 800,
      naturalContentHeight: 850
    });
    assert.strictEqual(res.isScrollable, true, "Content must be scrollable");
    assert(res.renderedHeight <= MAX_POPUP_HEIGHT, `Rendered height (${res.renderedHeight}) <= MAX (${MAX_POPUP_HEIGHT})`);
    assert(res.bottom <= 800 - VIEWPORT_MARGIN, `Popup bottom (${res.bottom}) <= viewport bottom (${800 - VIEWPORT_MARGIN})`);
    assert(res.top >= VIEWPORT_MARGIN, "Popup top >= safe margin");
  });

  // TEST 3: Selection near bottom of viewport (selectionRect.top = 720 in 800px viewport)
  test("TEST 3: Selection near bottom of viewport -> flips above selection and fits completely", () => {
    const res = simulatePositionPopup({
      selectionRect: { left: 300, top: 720, right: 380, bottom: 740, width: 80, height: 20 },
      viewportWidth: 1200,
      viewportHeight: 800,
      naturalContentHeight: 500
    });
    assert.strictEqual(res.placeBelow, false, "Must place above selection when bottom has no room");
    assert(res.bottom <= 720, `Popup bottom (${res.bottom}) must be at or above selection top (720)`);
    assert(res.top >= VIEWPORT_MARGIN, `Popup top (${res.top}) >= margin (${VIEWPORT_MARGIN})`);
    assert(res.renderedHeight <= 500, "Rendered height is constrained properly");
  });

  // TEST 4: Selection near top of viewport (selectionRect.top = 20 in 800px viewport)
  test("TEST 4: Selection near top of viewport -> places below and fits completely", () => {
    const res = simulatePositionPopup({
      selectionRect: { left: 300, top: 20, right: 380, bottom: 40, width: 80, height: 20 },
      viewportWidth: 1200,
      viewportHeight: 800,
      naturalContentHeight: 700
    });
    assert.strictEqual(res.placeBelow, true, "Must place below selection when top has no room");
    assert(res.top >= 40 + SELECTION_GAP, `Popup top (${res.top}) >= selection bottom + gap`);
    assert(res.bottom <= 800 - VIEWPORT_MARGIN, `Popup bottom (${res.bottom}) <= viewport bottom`);
    assert.strictEqual(res.isScrollable, true, "Should scroll long content");
  });

  // TEST 5: Very small viewport (height = 400px, e.g. mobile landscape or small laptop)
  test("TEST 5: Very small viewport (height = 400px) -> adapts and NEVER overflows viewport bottom", () => {
    const res = simulatePositionPopup({
      selectionRect: { left: 300, top: 160, right: 380, bottom: 180, width: 80, height: 20 },
      viewportWidth: 800,
      viewportHeight: 400,
      naturalContentHeight: 600
    });
    assert(res.bottom <= 400 - VIEWPORT_MARGIN, `Popup bottom (${res.bottom}) MUST be <= 400 - 16 (${384})`);
    assert(res.top >= VIEWPORT_MARGIN, `Popup top (${res.top}) >= 16`);
    assert.strictEqual(res.isScrollable, true, "Content must be scrollable in constrained viewport");
  });

  // TEST 6: Selection near left edge of viewport (left = 5px)
  test("TEST 6: Selection near left edge (left = 5px) -> clamped to horizontal margin", () => {
    const res = simulatePositionPopup({
      selectionRect: { left: 5, top: 200, right: 55, bottom: 220, width: 50, height: 20 },
      viewportWidth: 1000,
      viewportHeight: 800,
      naturalContentHeight: 300
    });
    assert.strictEqual(res.left, VIEWPORT_MARGIN, `Popup left (${res.left}) must be clamped to VIEWPORT_MARGIN (${VIEWPORT_MARGIN})`);
  });

  // TEST 7: Selection near right edge of viewport (right = 995px in 1000px viewport)
  test("TEST 7: Selection near right edge (right = 995px) -> clamped to horizontal margin", () => {
    const res = simulatePositionPopup({
      selectionRect: { left: 945, top: 200, right: 995, bottom: 220, width: 50, height: 20 },
      viewportWidth: 1000,
      viewportHeight: 800,
      naturalContentHeight: 300
    });
    assert.strictEqual(res.right, 1000 - VIEWPORT_MARGIN, `Popup right (${res.right}) must be clamped to 1000 - margin (${1000 - VIEWPORT_MARGIN})`);
  });

  // TEST 8: Long passage explanation (800px content, middle of screen)
  test("TEST 8: Long passage explanation chooses side with more space and scrolls", () => {
    const res = simulatePositionPopup({
      selectionRect: { left: 400, top: 350, right: 500, bottom: 420, width: 100, height: 70 },
      viewportWidth: 1200,
      viewportHeight: 800,
      naturalContentHeight: 800
    });
    assert(res.bottom <= 800 - VIEWPORT_MARGIN, `Popup bottom (${res.bottom}) <= 800 - 16`);
    assert(res.top >= VIEWPORT_MARGIN, `Popup top (${res.top}) >= 16`);
    assert.strictEqual(res.isScrollable, true, "Long passage is scrollable");
  });

  console.log(`\nResults: ${passed}/${total} passed.\n`);
  if (passed !== total) process.exit(1);
}

runSuite();
