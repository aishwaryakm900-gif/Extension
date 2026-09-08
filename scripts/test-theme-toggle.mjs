import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

console.log("=== TESTING LIGHT / DARK THEME TOGGLE IMPLEMENTATION ===\n");

// 1. Verify extension pdf-reader.html has the theme toggle
const htmlContent = fs.readFileSync(path.resolve("extension/pdf-reader.html"), "utf8");
assert(htmlContent.includes('id="theme-light-btn"'), "pdf-reader.html must have theme-light-btn");
assert(htmlContent.includes('id="theme-dark-btn"'), "pdf-reader.html must have theme-dark-btn");
assert(htmlContent.includes('theme-segmented-control'), "pdf-reader.html must have theme-segmented-control");
console.log("[PASS] extension/pdf-reader.html contains segmented theme toggle with light and dark buttons.");

// 2. Verify extension pdf-reader.ts has theme switching & persistence logic
const tsContent = fs.readFileSync(path.resolve("extension/pdf-reader.ts"), "utf8");
assert(tsContent.includes('localStorage.setItem("reader_theme"'), "pdf-reader.ts must save theme to localStorage");
assert(tsContent.includes('chrome.storage.local.set({ reader_theme: theme }'), "pdf-reader.ts must sync theme to chrome.storage.local");
assert(tsContent.includes('data-theme'), "pdf-reader.ts must set data-theme attribute on document");
console.log("[PASS] extension/pdf-reader.ts implements theme persistence, chrome.storage sync, and DOM updates.");

// 3. Verify extension pdf-reader.css has dark theme rules and filters
const cssContent = fs.readFileSync(path.resolve("extension/pdf-reader.css"), "utf8");
assert(cssContent.includes('[data-theme="dark"]'), "pdf-reader.css must have [data-theme='dark'] rules");
assert(cssContent.includes('filter: invert('), "pdf-reader.css must have invert filter for dark mode reading");
assert(cssContent.includes('.theme-segmented-control'), "pdf-reader.css must have styles for theme-segmented-control");
console.log("[PASS] extension/pdf-reader.css contains dark theme overrides, canvas inversion, and toggle styles.");

// 4. Verify React PdfReader.tsx has theme toggle and data-theme
const reactContent = fs.readFileSync(path.resolve("components/reader/PdfReader.tsx"), "utf8");
assert(reactContent.includes('theme-segmented-control'), "PdfReader.tsx must render theme-segmented-control");
assert(reactContent.includes('data-theme={theme}'), "PdfReader.tsx must pass data-theme to main shell");
assert(reactContent.includes('localStorage.setItem("reader_theme"'), "PdfReader.tsx must persist theme");
console.log("[PASS] components/reader/PdfReader.tsx renders theme switcher and binds theme state.");

// 5. Verify globals.css has dark theme styles
const globalsCss = fs.readFileSync(path.resolve("app/globals.css"), "utf8");
assert(globalsCss.includes('.pdf-reader-shell[data-theme="dark"]'), "globals.css must have dark theme styles for shell");
assert(globalsCss.includes('filter: invert('), "globals.css must have canvas inversion in dark mode");
console.log("[PASS] app/globals.css contains dark theme styles for web reader.");

// 6. Verify content.ts supports dark theme
const contentTs = fs.readFileSync(path.resolve("extension/content.ts"), "utf8");
assert(contentTs.includes('.popup[data-theme="dark"]'), "content.ts must define dark popup styles");
assert(contentTs.includes('popup.setAttribute("data-theme"'), "content.ts must set data-theme on popup");
console.log("[PASS] extension/content.ts supports dark theme for webpage selection popups.");

console.log("\nALL THEME TOGGLE CHECKS PASSED!");
