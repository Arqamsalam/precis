// Prompt text for the AI summarizer. The system prompt never changes between requests,
// so it stays cache-friendly; everything that varies goes into the user message.

export const SYSTEM_PROMPT = `You are Précis, an expert editor who condenses texts. You write abridgments: shorter versions of a text that stay true to everything the original contains and read as if its own author had written them more concisely.

How you work:

Faithful, complete coverage. Carry every significant element of the source into the summary (events, arguments, evidence, figures, characters, relationships, turning points, outcomes and conclusions), giving each a share of the summary proportional to its weight in the original. Cover the whole text evenly; the last part deserves the same care as the first. When space is tight, compress (merge, generalize, tighten wording) rather than drop whole threads.

Nothing sanitized. The user supplied this text and wants an honest condensed version of it. Material that is sexual, violent, profane, disturbing, criminal, politically or religiously charged, offensive, or otherwise sensitive is part of the content: keep it in proportion to its role in the original, described with the same level of directness the original uses unless the user asks for different wording. Don't omit it, blur it into vague phrases ("an intimate encounter", "some violence"), soften the author's language, or add warnings, disclaimers, judgments or commentary of your own. Present views the text expresses as the text's views, accurately, whether or not you share them.

Voice and style. Unless told otherwise, keep the original's voice, tone, register, point of view, tense and genre. Fiction stays fiction: a condensed narrative with its mood, dialogue flavor and pacing, not a book report. An argument keeps its line of reasoning and rhetorical character. Technical, legal or academic writing keeps its precision and defined terms. Casual writing stays casual. Reuse the author's distinctive vocabulary and names, and quote short lines verbatim where they carry weight.

Accuracy. Add nothing that isn't in the source: no outside facts, no speculation, no invented connective detail. Keep names, numbers, dates and technical terms exact, and keep the author's hedges and levels of certainty.

Length. Aim closely at the requested word count (within about 10%). A longer target means more detail and more of the original's texture, never padding or repetition.

Output. Write only the summary itself, in Markdown: no preamble ("Here is…"), no notes about your process, no closing remarks. Use headings, lists or emphasis only where the requested format or the original's own structure calls for them.`;

export const FORMATS = {
  preserve: {
    label: 'Keep original style',
    hint: 'Reads like a shorter version written by the same author',
    text: "Format: a condensed version of the original in its own form and voice. Mirror the original's structure: if it has chapters or titled sections, keep matching headings (minor ones may be merged); if it is continuous prose, write continuous prose paragraphs; if it is a list, report or letter, keep that form.",
  },
  narrative: {
    label: 'Narrative overview',
    hint: 'Describes the text in the third person',
    text: "Format: a third-person prose overview that describes what the text says or what happens in it (for example \"The author argues…\", \"In the opening chapter…\"), in well-organized paragraphs that follow the original's order.",
  },
  bullets: {
    label: 'Bullet points',
    hint: 'Grouped, specific bullets',
    text: "Format: a bullet-point summary grouped under short headings that follow the original's order. Each bullet is a complete, specific statement with the concrete details (names, numbers, outcomes), never a vague keyword fragment.",
  },
  executive: {
    label: 'Executive brief',
    hint: 'Bottom line first, then key points',
    text: 'Format: an executive brief. Start with a **Bottom line** paragraph (2–4 sentences). Then **Key points** as bullets. Then **Details** in short titled sections following the original\'s order. Finish with **Implications** only if the text itself supports them.',
  },
  sections: {
    label: 'Chapter by chapter',
    hint: 'A heading and summary for each part',
    text: "Format: a section-by-section summary. Give each chapter or major section of the original its own heading (use the original's titles where they exist), followed by a prose summary of that section. Allocate words to sections in proportion to their length and importance.",
  },
  study: {
    label: 'Study notes',
    hint: 'Headings, bold key terms, review questions',
    text: 'Format: study notes. Use headings for the main topics, concise explanatory bullets, **bold** key terms, and end with a short "Review questions" list (questions answerable from the text).',
  },
  tldr: {
    label: 'TL;DR + summary',
    hint: 'One-line gist, then the full summary',
    text: 'Format: begin with a single line starting with **TL;DR:** that captures the whole text in one sentence, then a blank line, then the full summary in prose paragraphs.',
  },
};

export const TONES = {
  match: { label: 'Match the original', text: '' },
  formal: { label: 'Formal / professional', text: 'Tone: formal and professional, while keeping all of the content.' },
  simple: { label: 'Plain & simple', text: 'Tone: plain, simple language anyone can follow: short sentences, everyday words, jargon briefly explained. Keep every substantive point.' },
  academic: { label: 'Academic', text: 'Tone: academic and analytical, precise and well-structured.' },
  conversational: { label: 'Conversational', text: 'Tone: friendly and conversational, as if explaining it to a friend.' },
  vivid: { label: 'Vivid storytelling', text: 'Tone: vivid and engaging, with the energy of good storytelling, without adding anything that is not in the text.' },
};

export const EXTRAS = {
  takeaways: { label: 'Key takeaways', text: '"Key takeaways": 5–10 bullets with the most important points.' },
  people: { label: 'People & characters', text: '"People and characters": each significant person or character with a one-line description of who they are and their role.' },
  quotes: { label: 'Notable quotes', text: '"Notable quotes": 3–8 striking verbatim quotations from the text, with the speaker when known.' },
  glossary: { label: 'Glossary', text: '"Glossary": key terms, names of places/organizations and jargon, each with a short definition as used in the text.' },
  timeline: { label: 'Timeline', text: '"Timeline": the events in chronological order, with dates or times where the text gives them.' },
};

export const LANGUAGES = ['English', 'Urdu', 'Arabic', 'Hindi', 'Bengali', 'Persian', 'Turkish', 'Spanish', 'French',
  'German', 'Portuguese', 'Italian', 'Dutch', 'Russian', 'Ukrainian', 'Polish', 'Indonesian', 'Malay', 'Swahili',
  'Chinese (Simplified)', 'Chinese (Traditional)', 'Japanese', 'Korean', 'Vietnamese', 'Thai'];

function optionLines(o) {
  const lines = [];
  lines.push((FORMATS[o.format] || FORMATS.preserve).text);
  const tone = (TONES[o.tone] || TONES.match).text;
  if (tone) lines.push(tone);
  lines.push(o.language && o.language !== 'same'
    ? `Language: write the summary in ${o.language}${o.language === 'English' ? '' : ' (translate faithfully; keep names and key terms recognisable)'}.`
    : 'Language: write in the same language as the original.');
  if (o.mature === 'clinical') {
    lines.push('Mature content: keep explicit sexual or violent passages in the summary at their full proportion, but describe them in clear, neutral, non-graphic wording.');
  }
  lines.push(o.quotes === false
    ? 'Quotations: paraphrase rather than quote.'
    : 'Quotations: keep a few short verbatim quotes where the exact wording matters.');
  return lines;
}

function extrasBlock(extras) {
  const list = (extras || []).filter((k) => EXTRAS[k]);
  if (!list.length) return '';
  return `After the summary, add these sections, each under its own "##" heading, in this order (they are extra and do not count toward the target length):\n${list.map((k) => '- ' + EXTRAS[k].text).join('\n')}`;
}

function customBlock(custom) {
  const c = (custom || '').trim();
  return c ? `Additional instructions from the user (these take priority over the defaults above where they conflict):\n${c}` : '';
}

function docTag(tag, title, words, text) {
  const t = (title || 'Untitled').replace(/"/g, "'");
  return `<${tag} title="${t}" words="${words}">\n${text}\n</${tag}>`;
}

/** Single request: the whole document at once. Returns [documentBlock, instructionsBlock]. */
export function singlePassPrompt({ title, text, words, target, ratio, options }) {
  const instructions = [
    `Write a summary of the document above in about ${target.toLocaleString('en-US')} words (${Math.round(ratio * 100)}% of the original's ${words.toLocaleString('en-US')} words).`,
    ...optionLines(options),
    customBlock(options.custom),
  ].filter(Boolean).join('\n\n');
  return [docTag('document', title, words, text), `<instructions>\n${instructions}\n</instructions>`];
}

/** Follow-up turn asking for the extra sections, answered from the original still in context. */
export function extrasFollowupPrompt(options) {
  return `${extrasBlock(options.extras).replace('After the summary, add these sections', 'Now write these sections for the same document')}
${options.language && options.language !== 'same' ? `Write them in ${options.language}.` : 'Write them in the same language as the summary.'}
Base them on the full original, with quotes taken verbatim from it. Output only these sections.`;
}

/** One part of a long document, condensed in sequence so the parts join into one summary. */
export function chunkPrompt({ title, text, words, target, ratio, options, index, total, previous }) {
  const isLast = index === total - 1;
  const context = previous
    ? `<condensed_so_far>\n${previous}\n</condensed_so_far>\n\nAbove is the end of the condensed text written so far for the earlier parts (for continuity only; do not repeat or rewrite it).\n\n`
    : '';
  const instructions = [
    `This is part ${index + 1} of ${total} of a long document titled "${title || 'Untitled'}", which is being condensed part by part to ${Math.round(ratio * 100)}% of its length. Condense ONLY this part, in about ${target.toLocaleString('en-US')} words.`,
    `Your text will be placed directly after the condensed text of the previous parts, so continue seamlessly: don't add a title, a "Part ${index + 1}" label or a recap; don't re-introduce people or ideas already introduced; ${isLast ? 'this is the final part, so bring the summary to the same close as the original.' : "don't wrap up or conclude, because more parts follow."} Keep any chapter or section headings that occur inside this part.`,
    ...optionLines({ ...options, extras: [] }),
    options.format === 'tldr' && index > 0 ? 'Skip the TL;DR line for this part; it was already written at the start.' : '',
    customBlock(options.custom),
  ].filter(Boolean).join('\n\n');
  return `${context}${docTag('document_part', `${title || 'Untitled'} (part ${index + 1} of ${total})`, words, text)}\n\n<instructions>\n${instructions}\n</instructions>`;
}

/** Map step for very long documents with a short target: dense notes that keep content and voice. */
export function notesPrompt({ title, text, words, target, index, total }) {
  return `${docTag('document_part', `${title || 'Untitled'} (part ${index + 1} of ${total})`, words, text)}

<instructions>
This is part ${index + 1} of ${total} of a long document. Condense this part into dense, faithful notes of about ${target.toLocaleString('en-US')} words that a later editor will use to write the final summary of the whole document without seeing the original. Keep, in order: every event, argument, finding and figure; every person or character and what they do; distinctive phrasing and the most important lines verbatim (in quotation marks); and short observations on tone and style. Include sensitive or explicit material exactly as directly as the original does. Write in the original's language. Output only the notes.
</instructions>`;
}

/** Reduce step: write the final summary from the ordered notes. */
export function reducePrompt({ title, notes, originalWords, target, ratio, options }) {
  const instructions = [
    `The notes above cover the entire document "${title || 'Untitled'}" (${originalWords.toLocaleString('en-US')} words) in order, preserving its content and voice. Using them, write the summary of the original document in about ${target.toLocaleString('en-US')} words (${Math.round(ratio * 100)}% of the original). Write it as a summary of the document itself; don't mention the notes.`,
    ...optionLines(options),
    customBlock(options.custom),
  ].filter(Boolean).join('\n\n');
  return `${docTag('notes', title, countApprox(notes), notes)}\n\n<instructions>\n${instructions}\n</instructions>`;
}

/** Extras for long documents, generated after the parts are joined. */
export function extrasPrompt({ title, summary, extras, options }) {
  return `${docTag('condensed_document', title, countApprox(summary), summary)}

<instructions>
${extrasBlock(extras).replace('After the summary, add these sections', 'Write these sections for the document above')}
${options.language && options.language !== 'same' ? `Write them in ${options.language}.` : 'Write them in the same language as the document.'}
Quotes must be taken verbatim from the text above. Output only the sections.
</instructions>`;
}

export function lengthFixPrompt({ actual, target }) {
  const longer = actual < target;
  return `That summary is ${actual.toLocaleString('en-US')} words, but the target is about ${target.toLocaleString('en-US')}. Rewrite the complete summary at about ${target.toLocaleString('en-US')} words, keeping the same format, tone and instructions. ${longer
    ? 'Add more of the original\'s detail, texture and specific content (spread evenly across the whole text), not filler.'
    : 'Tighten wording and merge minor points, but keep every significant element and its proportion.'} Output only the revised summary.`;
}

function countApprox(s) {
  return (s.match(/\S+/g) || []).length;
}
