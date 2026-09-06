# Reader AI

Reader AI is a browser reading companion. It detects selected text on ordinary webpages, gathers its context, and asks a server-side AI provider for a contextual explanation.

## Next.js app

```bash
npm install
npm run build:extension
npm run dev
```

Open http://localhost:3000.

Before explaining text, copy `.env.example` to `.env.local` or edit the existing `.env.local` and add a real server-side key:

```env
AI_API_KEY=your_real_provider_key
AI_MODEL=gpt-4o-mini
```

The default provider is the OpenAI-compatible Chat Completions API. `AI_API_URL` can override the endpoint for a compatible provider. The key is read only by the Next.js server and is never bundled into the extension.

## Chrome extension

Build the TypeScript extension:

```bash
npm run build:extension
```

In Chrome, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the project `extension` folder. Open the extension's **Details** page and enable **Allow access to file URLs**. Reload the extension after rebuilding it.

To test webpage reading, start the Next.js server on port 3000, open any HTTP, HTTPS, or local `file://` webpage with readable text, and select a word or phrase. A Reader AI popup should appear beside the selection with the selected text and its surrounding sentence and paragraph. Click **Explain with AI** to send the normalized context through the extension service worker to `/api/explain`. The popup adapts to word, phrase, sentence, and passage responses.

## Local PDF reader

Chrome's built-in PDF viewer is not a normal webpage and cannot be treated as one. Start the Next.js app, open `http://localhost:3000/reader/pdf`, and choose **Open PDF**. The file is read locally with PDF.js; it is not uploaded as a PDF. Reader AI renders page artwork with a selectable text layer, preserves page boundaries and page numbers, derives a bounded local paragraph plus nearby page context, and sends only that context to the same `/api/explain` endpoint as webpages. Scanned or image-only PDFs are not supported until OCR is added.

The extension popup also includes **Open PDF in Reader AI** as a shortcut to `http://localhost:3000/reader/pdf`. It does not attempt to inject into Chrome's native PDF viewer or fetch a `file://` URL from the extension.

After changing extension TypeScript or PDF reader code, rebuild it:

```bash
npm run build:extension
```

## Current scope

This MVP does not include authentication, database storage, PDFs, OCR, or vocabulary persistence yet. The Save to Vocabulary button is intentionally disabled until a later phase.
