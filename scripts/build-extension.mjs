import { build } from "esbuild";

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
