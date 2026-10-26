# Précis: free, private, offline summarizer

**Précis** (say *“pray-see”*) shortens long documents to exactly the length you choose, **entirely inside your browser**. No account, no API key, no cost, and your text never leaves your device.

Think of a careful reader with a highlighter and a pair of scissors: they read every sentence, work out which ones carry the story or argument, and cut away the rest, keeping **the author's own words**. Nothing is reworded, softened or censored.

🌐 **Use it:** https://arqamsalam.github.io/precis/

---

## Features

| | |
|---|---|
| 📄 **Reads almost any file** | PDF (with page ranges), Word `.docx`, EPUB e-books, PowerPoint `.pptx`, OpenDocument `.odt`, RTF, HTML, Markdown/TXT, CSV/JSON, subtitles `.srt`/`.vtt`, and **images or scanned PDFs** via text recognition (OCR) in 24 languages. Drag and drop, browse, or paste. |
| 🎚️ **Any length** | A slider from 1% to 90%, presets, or an exact word count. Results land within about 1% of the target. |
| ⚡ **Instant, live updates** | After the first summary, move the slider or change an option and the summary updates immediately. A whole novel takes about a second. |
| 🧵 **Reads smoothly** | Keeps a sentence together with the one it depends on, drops stray connectors (“However,”, “Second,”) when their partner was cut, finishes list fragments properly, never splits quoted dialogue, and skips near-duplicate sentences. Optional: trim (asides) and citations, mark cuts with […]. |
| ⚖️ **Balanced coverage** | Every part of the text gets its fair share, so the ending is covered as well as the beginning. A coverage bar shows where the chosen sentences come from. |
| 🎯 **Focus** | Type words or names to prioritise (e.g. “budget, Elias”). |
| 🔍 **In context** | See the chosen sentences highlighted inside the full original. |
| 🧾 **Layouts and extras** | Flowing paragraphs, bullet points, or section by section. Add key takeaways, keywords, names mentioned, notable quotes (with speakers), key figures and a timeline. |
| 🔊 **Listen** | Read aloud with a choice of voices, speed and pitch; the current paragraph is highlighted. In **Microsoft Edge** this includes Microsoft's free natural voices (Andrew, Ava, Emma, Brian and many more, including Urdu). |
| 💾 **Exports** | PDF, Word `.docx`, Markdown, HTML web page, plain text; copy as formatted text; print. |
| 🗂️ **History, themes, mobile** | Past summaries saved in your browser, light/dark theme, works on phones. |

## How it chooses sentences

1. **Centrality (TextRank).** Every sentence “votes” for the sentences it shares important words with, much like web pages linking to each other. The sentences that many others point to are the backbone of the text.
2. **Key terms.** Words that are frequent in this text but rare overall (names, topics) make a sentence more valuable, both for the whole document and within its own chapter.
3. **Position and signals.** Opening sentences of paragraphs and phrases such as “in conclusion” or “the main reason” get a boost; examples (“for instance…”) get less.
4. **Fair shares.** The text is walked through in stretches, and each stretch spends its share of the word budget on its best sentences, skipping repeats and keeping dependent pairs together.
5. **Polish.** Connectors and list endings are tidied, paragraphs are rebuilt, and chapter headings are kept.

Because it only selects sentences, the summary can't misquote the author, add anything, or leave out sensitive material because of what it says. The trade-off: it can't rephrase. Very short summaries of novels (under ~5%) can feel like a sequence of key moments rather than a retelling.

## Listening with natural voices

Précis uses the voices built into your browser:

- **Microsoft Edge** (Windows, Mac, Android, iOS) offers Microsoft's free natural voices such as *Andrew*, *Ava*, *Emma*, *Brian* and *Jenny*, plus natural voices in dozens of other languages, including Urdu (*Uzma*, *Asad*). They appear first in the voice list, marked with ★.
- **Chrome** offers Google voices; **Safari** offers Apple voices (you can download better “Enhanced”/“Premium” ones in your system's settings).

Online voices (like Edge's natural voices) are spoken by the browser maker's service, so the browser sends the text being read to that service. Voices marked “on this device” are fully private.

## Privacy

- Files are opened and summarized inside your browser. This site has no server and stores nothing.
- History and settings are kept in your browser's local storage.
- The only things downloaded are the page itself and, the first time you read a scanned page or image, the open-source text-recognition engine.

## Running it yourself

The site is plain HTML, CSS and JavaScript with no build step. To run it on your own computer: `python3 -m http.server` in this folder, then open <http://localhost:8000>.

To publish your own copy on GitHub Pages: **Settings → Pages → Deploy from a branch → `main` / root**.

## Project layout

```
index.html               page structure
css/styles.css           design (light + dark themes, mobile layout)
js/app.js                user interface
js/summarizer.js         the summarizing engine (TextRank, selection, smoothing, extras)
js/summarizer-worker.js  runs the engine in the background so the page stays responsive
js/engine.js             talks to the worker
js/speech.js             read-aloud player and voice list
js/extract.js            reading files (PDF, Word, EPUB, PPTX, ODT, RTF, OCR, …)
js/export.js             PDF, Word, Markdown, HTML and text export
js/storage.js            settings and history (browser storage)
vendor/                  bundled open-source libraries (see vendor/licenses)
```

## Credits

Built with [PDF.js](https://mozilla.github.io/pdf.js/), [Mammoth](https://github.com/mwilliamson/mammoth.js), [JSZip](https://stuk.github.io/jszip/), [pdfmake](http://pdfmake.org), [docx](https://docx.js.org), [marked](https://marked.js.org), [DOMPurify](https://github.com/cure53/DOMPurify) and [Tesseract.js](https://tesseract.projectnaptha.com) (loaded on demand for OCR). Their licenses are in `vendor/licenses/`.

Released under the MIT License.
