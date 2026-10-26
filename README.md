# Précis: faithful text summarizer

**Précis** (say *“pray-see”*) turns long documents into summaries of exactly the length you choose, while keeping the author's voice, tone and every important detail.

Think of it as a skilled editor making an **abridged edition** of a book: the book gets shorter, but it's still the same book, with the same characters, arguments, style and even its uncomfortable parts. Nothing is censored or watered down.

🌐 **Use it online:** `https://arqamsalam.github.io/precis/` (live once GitHub Pages is switched on, see [Publishing](#publishing-on-github-pages))

---

## What it can do

| | |
|---|---|
| 📄 **Reads almost any file** | PDF (with page ranges), Word `.docx`, EPUB e-books, PowerPoint `.pptx`, OpenDocument `.odt`, RTF, HTML, Markdown/TXT, CSV/JSON, subtitles `.srt`/`.vtt`, and **images or scanned PDFs via OCR** (text recognition in 24 languages). Several files at once, drag-and-drop or paste. |
| 🎚️ **Length slider** | 1% to 90% of the original, with presets (gist, brief, standard, detailed, light trim) or an exact word count. |
| ✍️ **Keeps the style** | Fiction stays a story, a legal text stays precise, a casual post stays casual. Key quotes are kept word-for-word. |
| 🚫 **No censorship** | Mature, explicit, violent or controversial content is kept in proportion and with the original's directness, with no warnings or moralizing. Optionally keep it in neutral wording instead. |
| 🧭 **7 formats** | Original style · narrative overview · bullet points · executive brief · chapter by chapter · study notes · TL;DR. |
| 🎨 **6 tones, 25 languages** | Match the original, formal, plain and simple, academic, conversational, vivid. Summarize into Urdu, Arabic, English, Spanish, Chinese and more (right-to-left scripts supported). |
| ➕ **Extra sections** | Key takeaways, people & characters, notable quotes, glossary, timeline. |
| 📚 **Any length of document** | Whole novels and long reports are handled automatically (see [How it works](#how-it-works)). |
| 💾 **Exports** | PDF, Word `.docx`, Markdown, HTML web page, plain text; copy as formatted text; print. |
| 🔊 **Extras** | Read aloud, edit the summary, history of past summaries, light/dark theme, cost estimate before you run. |

## Three engines

1. **Claude AI** (recommended, best quality): uses your own [Anthropic API key](https://console.anthropic.com/settings/keys). Choose Opus 5.5 (best), Sonnet 5.5 (faster, half price), Haiku 5.5 (cheapest) or Fable 5.1 (most capable). A typical article costs a few cents with Opus and a fraction of a cent with Haiku.
2. **Other AI / local model**: any OpenAI-compatible service (OpenAI, OpenRouter's hundreds of models) or a model running on **your own computer** with Ollama or LM Studio, for complete privacy.
3. **Offline**: no AI, no key, free. Ranks every sentence by how central it is (the *TextRank* method) and keeps the most important ones in their original order.

## How it works

**1. Reading the file.** Everything happens inside your browser, like opening a document in a desktop app. Nothing is uploaded to this website. PDFs are rebuilt into proper paragraphs, with repeated page headers and page numbers stripped out.

**2. Choosing the length.** The slider sets a word budget: 25% of a 20,000-word text is about 5,000 words. Think of a short percentage as the *skeleton* (every major event and argument) and a higher one as putting back the *muscle* (examples, dialogue, texture).

**3. Writing the summary.** The AI is briefed like a professional editor: cover the whole text evenly, give each part space in proportion to its weight, keep the author's voice, add nothing that isn't there, and leave nothing out because it is sensitive.

**4. Long documents.** A very long book is handled the way a careful reader with a notebook would:

- **Long summaries** (say 25% of a novel) are written *part by part*. Each part is condensed to the same percentage while the AI sees the end of what it has already written, so the parts join into one smooth text without repeating introductions.
- **Short summaries of huge texts** (say 2% of a 500-page book) use *notes first*: dense notes are taken on each part, then the final summary is written from all the notes together.

**5. Hitting the target.** If a summary misses the requested length by more than 25%, Précis asks the AI for one revision at the right length. The original stays in the AI's memory (cached), so this is cheap.

## Privacy

- Files are opened in your browser. This site has no server and stores nothing.
- When you summarize, the text goes **directly from your browser to the AI service you chose**, using your own key.
- API keys and history are kept in your browser's local storage. Untick *Remember API keys* to keep a key only for the current tab.
- Offline mode and local models (Ollama/LM Studio) never send your text over the internet.

## Using a local model (Ollama)

```bash
# 1. Install Ollama from https://ollama.com, then download a model:
ollama pull llama3.1
# 2. Start it so it accepts requests from the web page:
OLLAMA_ORIGINS="*" ollama serve
```

In **Settings → Other AI / local**, pick *Ollama*, enter the model name and set the context window to what your model supports. Long texts are split to fit automatically.

## Publishing on GitHub Pages

The site is plain HTML, CSS and JavaScript, so there is nothing to build.

1. Open the repository on GitHub → **Settings** → **Pages**.
2. Under *Build and deployment*, set **Source: Deploy from a branch**, **Branch: `main`**, folder **`/ (root)`**, then **Save**.
3. After a minute the site is live at `https://<your-username>.github.io/<repository-name>/`.

To run it on your own computer: `python3 -m http.server` in this folder, then open <http://localhost:8000>.

## Project layout

```
index.html          page structure
css/styles.css      design (light + dark themes, mobile layout)
js/app.js           user interface
js/extract.js       reading files (PDF, Word, EPUB, PPTX, ODT, RTF, OCR, …)
js/ai.js            AI engine: Claude via the official SDK, OpenAI-compatible APIs, long-document planning
js/prompts.js       the editor's instructions given to the AI
js/extractive.js    offline TextRank summarizer
js/export.js        PDF, Word, Markdown, HTML and text export
js/storage.js       settings and history (browser storage)
vendor/             bundled open-source libraries (see vendor/licenses)
```

## Credits

Built with [Anthropic's Claude SDK](https://github.com/anthropics/anthropic-sdk-typescript), [PDF.js](https://mozilla.github.io/pdf.js/), [Mammoth](https://github.com/mwilliamson/mammoth.js), [JSZip](https://stuk.github.io/jszip/), [pdfmake](http://pdfmake.org), [docx](https://docx.js.org), [marked](https://marked.js.org), [DOMPurify](https://github.com/cure53/DOMPurify) and [Tesseract.js](https://tesseract.projectnaptha.com) (loaded on demand for OCR). Their licenses are in `vendor/licenses/`.

Released under the MIT License.
