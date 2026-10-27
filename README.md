# Précis: free, private text summarizer

**Précis** (say *“pray-see”*) shortens long documents to exactly the length you choose, **inside your browser**. No account, no API key, no cost. Your text never leaves your device.

It works in two steps, like a research team:

1. **The researcher** (always on, instant): reads every sentence and picks the ones that carry the story or argument, keeping the **author's own words**, with fair coverage from start to finish.
2. **The editor** (optional): a small AI model running on your own graphics card rewrites those key sentences into smooth, connected prose, keeping every detail and adding nothing.

🌐 **Use it:** https://arqamsalam.github.io/precis/
📲 **Install it:** open the site and press **Install app** (Chrome/Edge), or *Add to Home Screen* on phones. It then works offline.

---

## Features

| | |
|---|---|
| 📄 **Reads almost any file** | PDF (with page ranges), Word `.docx`, EPUB, PowerPoint `.pptx`, OpenDocument `.odt`, RTF, HTML, Markdown/TXT, CSV/JSON, subtitles, and images. |
| 🔍 **OCR for scanned PDFs** | Pages without text are recognised automatically (24 languages, including Urdu and Arabic). **Read all pages with OCR** fixes PDFs whose built-in text is garbled. |
| 🎚️ **Any length** | 1% to 90%, presets, or an exact word count, accurate to about 1%. Updates instantly as you move the slider. |
| 🧵 **Reads smoothly** | Keeps dependent sentences together, drops stray connectors, finishes list fragments, never splits dialogue, skips repetition. |
| ✍️ **AI rewrite on your device** | Optional smooth prose from Qwen 2.5 (1.5B, ~1 GB) or Hermes 3 (Llama 3.2 3B, ~1.8 GB) via WebLLM on your graphics card. Told never to soften or censor; refusals fall back to the author's sentences. |
| 🔊 **Natural voices** | Built-in neural voices (Kokoro: Heart, Bella, Emma, George…) that run offline after a one-time download, plus your browser's voices (Microsoft's natural voices in Edge). Speed, pitch, paragraph skipping, highlighting, and **Save as audio (.wav)**. |
| 🅰️ **Reading comfort** | Choose the font (including easy-to-read Atkinson Hyperlegible and Lexend, and Urdu Nastaliq), size, line spacing and width. Light/dark theme. |
| 🎯 **Focus, layouts, extras** | Prioritise words or names; paragraphs, bullets or section by section; key takeaways, keywords, names, quotes, key figures, timeline; *In context* view highlighting the chosen sentences in the original. |
| 💾 **Exports** | PDF, Word, Markdown, HTML, plain text, audio; copy; print; history. |
| 📴 **Works offline** | Installable app (PWA). Everything except the first downloads works without internet. |

## What gets downloaded, and when

Nothing needs to be downloaded by hand. The first time you use a feature, the browser fetches what it needs once and keeps it:

| When | What | Size | From |
|---|---|---|---|
| Opening the site | The app | ~5 MB | GitHub Pages |
| First scanned page or image | Text-recognition engine (Tesseract) + language data | ~5–15 MB | jsDelivr |
| First time you listen with a natural voice | Voice engine + Kokoro voice model | ~24 MB + ~90 MB (330 MB on graphics cards) | GitHub Pages + Hugging Face |
| First AI rewrite | AI engine + language model | ~12 MB + ~1 GB (or ~1.8 GB) | GitHub + Hugging Face |

## Requirements

- Any modern browser for summarizing, OCR, exports and natural voices.
- **AI rewrite** needs WebGPU: current **Chrome** or **Edge** on most Windows/Mac computers (and some Android phones), with about 2–4 GB of free graphics memory.
- Natural voices are fastest on a graphics card; on older computers, use **Save as audio** for gap-free playback.

## Privacy

- Files are opened, summarized, rewritten and read aloud **on your device**. This site has no server and stores nothing.
- History and settings are kept in your browser's local storage.
- The only exception is if you pick one of Edge's online voices: Edge sends the text being read to Microsoft to speak it.

## Running it yourself

Plain HTML, CSS and JavaScript, no build step: run `python3 -m http.server` in this folder and open <http://localhost:8000>. To publish your own copy: **Settings → Pages → Deploy from a branch → `main` / root**.

## Project layout

```
index.html, css/styles.css   page and design
sw.js, manifest.webmanifest  installable app, offline cache, multi-core speed-up
js/app.js                    user interface
js/summarizer.js (+ worker)  the summarizing engine
js/rewrite.js, llm-worker.js on-device AI rewrite (WebLLM)
js/speech.js, tts-worker.js  read-aloud player and natural voices (Kokoro)
js/extract.js                reading files and OCR
js/export.js                 PDF, Word, Markdown, HTML, text export
vendor/                      bundled open-source libraries (licenses in vendor/licenses)
```

## Credits and licenses

Built with [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) via [kokoro-js](https://www.npmjs.com/package/kokoro-js) and [Transformers.js](https://github.com/huggingface/transformers.js), [WebLLM](https://github.com/mlc-ai/web-llm), [ONNX Runtime Web](https://onnxruntime.ai), [PDF.js](https://mozilla.github.io/pdf.js/), [Tesseract.js](https://tesseract.projectnaptha.com), [Mammoth](https://github.com/mwilliamson/mammoth.js), [JSZip](https://stuk.github.io/jszip/), [pdfmake](http://pdfmake.org), [docx](https://docx.js.org), [marked](https://marked.js.org) and [DOMPurify](https://github.com/cure53/DOMPurify). Licenses are in `vendor/licenses/`. Note: `vendor/kokoro.mjs` includes [eSpeak NG](https://github.com/espeak-ng/espeak-ng), which is GPL-3.0 licensed. The AI models have their own licenses (Qwen 2.5: Apache 2.0; Hermes 3 / Llama 3.2: Llama 3.2 Community License; Kokoro: Apache 2.0).

Précis's own code is released under the MIT License.
