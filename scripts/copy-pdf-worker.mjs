import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const source = resolve("node_modules/pdfjs-dist/build/pdf.worker.min.mjs");
const destination = resolve("public/pdf.worker.min.mjs");
mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, destination);
