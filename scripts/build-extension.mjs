import { build } from "esbuild";

await build({
  entryPoints: ["extension/content.ts"],
  bundle: true,
  format: "iife",
  outfile: "extension/dist/content.js",
  platform: "browser",
  target: "es2020"
});

await build({
  entryPoints: ["extension/background.ts"],
  bundle: true,
  format: "esm",
  outfile: "extension/dist/background.js",
  platform: "browser",
  target: "es2020"
});

await build({
  entryPoints: ["extension/pdf-reader.ts"],
  bundle: true,
  format: "iife",
  outfile: "extension/dist/pdf-reader.js",
  platform: "browser",
  target: "es2020"
});

await build({
  entryPoints: ["node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
  bundle: true,
  format: "iife",
  outfile: "extension/dist/pdf.worker.js",
  platform: "browser",
  target: "es2020"
});
