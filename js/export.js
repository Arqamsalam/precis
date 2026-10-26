// Download the summary as PDF, Word, Markdown, HTML or plain text.
import { marked } from '../vendor/marked.mjs';
import DOMPurify from '../vendor/purify.mjs';
import { loadScript } from './extract.js';
import { escapeHtml, needsComplexScript, isRtl, slugify } from './textutil.js';

const VENDOR = new URL('../vendor/', import.meta.url).href;

export function renderMarkdown(md) {
  return DOMPurify.sanitize(marked.parse(md || '', { gfm: true, breaks: false }));
}

export function markdownToPlain(md) {
  const div = document.createElement('div');
  div.innerHTML = renderMarkdown(md);
  const lines = [];
  const walk = (node, prefix = '') => {
    for (const el of node.children) {
      const tag = el.tagName;
      if (/^H[1-6]$/.test(tag)) lines.push('', el.textContent.trim().toUpperCase(), '');
      else if (tag === 'UL' || tag === 'OL') {
        [...el.children].forEach((li, i) => {
          const sub = [...li.children].filter((c) => c.tagName === 'UL' || c.tagName === 'OL');
          const own = [...li.childNodes].filter((c) => !sub.includes(c)).map((c) => c.textContent).join('').trim();
          lines.push(`${prefix}${tag === 'OL' ? `${i + 1}.` : '•'} ${own}`);
          sub.forEach((s) => walk({ children: [s] }, prefix + '   '));
        });
        lines.push('');
      } else if (tag === 'BLOCKQUOTE') {
        el.textContent.trim().split('\n').forEach((l) => lines.push('> ' + l.trim()));
        lines.push('');
      } else if (tag === 'HR') lines.push('—', '');
      else if (tag === 'TABLE') {
        el.querySelectorAll('tr').forEach((tr) => lines.push([...tr.children].map((c) => c.textContent.trim()).join(' | ')));
        lines.push('');
      } else {
        lines.push(el.textContent.trim(), '');
      }
    }
  };
  walk(div);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function save(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

export function fileStem(title, pct) {
  return `${slugify(title)}-summary-${pct}pct`;
}

function metaLine(meta) {
  const bits = [];
  if (meta.source) bits.push(`Source: ${meta.source}`);
  if (meta.pct != null) bits.push(`${meta.pct}% length`);
  if (meta.words) bits.push(`${meta.words.toLocaleString()} words`);
  bits.push(new Date(meta.date || Date.now()).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }));
  return bits.join('  ·  ');
}

// ------------------------------------------------ Markdown / Text / HTML

export function downloadMarkdown(md, meta) {
  const head = `# ${meta.title}\n\n*${metaLine(meta)}*\n\n---\n\n`;
  save(new Blob([head + md + '\n'], { type: 'text/markdown;charset=utf-8' }), `${meta.stem}.md`);
}

export function downloadText(md, meta) {
  const head = `${meta.title}\n${metaLine(meta)}\n${'='.repeat(Math.min(70, meta.title.length + 10))}\n\n`;
  save(new Blob([head + markdownToPlain(md)], { type: 'text/plain;charset=utf-8' }), `${meta.stem}.txt`);
}

export function standaloneHtml(md, meta) {
  const dir = isRtl(md) ? 'rtl' : 'ltr';
  return `<!doctype html>
<html lang="${meta.lang || 'en'}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(meta.title)} — Summary</title>
<style>
  :root { color-scheme: light dark; --ink:#1d1b18; --muted:#6b645a; --paper:#fbfaf7; --rule:#e6e0d6; --accent:#9a3412; }
  @media (prefers-color-scheme: dark) { :root { --ink:#ece7df; --muted:#a39b8f; --paper:#191714; --rule:#34302a; --accent:#fb923c; } }
  body { margin:0; background:var(--paper); color:var(--ink); font:18px/1.7 Georgia, "Times New Roman", serif; }
  main { max-width: 720px; margin: 0 auto; padding: 56px 24px 80px; }
  header { border-bottom:1px solid var(--rule); margin-bottom:32px; padding-bottom:20px; }
  .kicker { font:600 12px/1 system-ui, sans-serif; letter-spacing:.14em; text-transform:uppercase; color:var(--accent); }
  h1.title { font-size: 2.1em; line-height:1.2; margin:.35em 0 .3em; }
  .meta { font:14px/1.5 system-ui, sans-serif; color:var(--muted); }
  h1,h2,h3,h4 { line-height:1.3; margin:1.6em 0 .5em; }
  p, li, h1, h2, h3, blockquote { unicode-bidi: plaintext; }
  blockquote { margin:1.2em 0; padding:.2em 1.2em; border-inline-start:3px solid var(--accent); color:var(--muted); font-style:italic; }
  hr { border:0; border-top:1px solid var(--rule); margin:2em 0; }
  table { border-collapse: collapse; width:100%; font-size:.9em; } td, th { border:1px solid var(--rule); padding:6px 10px; text-align:start; }
  code { font-size:.88em; }
  footer { margin-top:56px; font:13px/1.5 system-ui, sans-serif; color:var(--muted); }
  @media print { body { background:#fff; color:#000; } main { padding:0; } }
</style>
</head>
<body>
<main>
<header>
  <div class="kicker">Summary</div>
  <h1 class="title">${escapeHtml(meta.title)}</h1>
  <div class="meta">${escapeHtml(metaLine(meta))}</div>
</header>
<article>
${renderMarkdown(md)}
</article>
<footer>Made with Précis</footer>
</main>
</body>
</html>`;
}

export function downloadHtml(md, meta) {
  save(new Blob([standaloneHtml(md, meta)], { type: 'text/html;charset=utf-8' }), `${meta.stem}.html`);
}

// ------------------------------------------------ inline runs from marked tokens

function runsOf(tokens, style = {}) {
  const out = [];
  for (const t of tokens || []) {
    switch (t.type) {
      case 'strong': out.push(...runsOf(t.tokens, { ...style, bold: true })); break;
      case 'em': out.push(...runsOf(t.tokens, { ...style, italics: true })); break;
      case 'del': out.push(...runsOf(t.tokens, { ...style, strike: true })); break;
      case 'codespan': out.push({ text: decode(t.text), ...style, code: true }); break;
      case 'br': out.push({ text: '\n', ...style }); break;
      case 'link': out.push(...runsOf(t.tokens, { ...style, link: t.href })); break;
      case 'image': out.push({ text: t.text || '', ...style }); break;
      case 'html': out.push({ text: t.text.replace(/<[^>]+>/g, ''), ...style }); break;
      case 'text':
        if (t.tokens?.length) out.push(...runsOf(t.tokens, style));
        else out.push({ text: decode(t.text), ...style });
        break;
      case 'escape': out.push({ text: decode(t.text), ...style }); break;
      default:
        if (t.tokens) out.push(...runsOf(t.tokens, style));
        else if (t.text) out.push({ text: decode(t.text), ...style });
    }
  }
  return out;
}

function decode(s) {
  if (!s || !s.includes('&')) return s;
  const ta = document.createElement('textarea');
  ta.innerHTML = s;
  return ta.value;
}

// ------------------------------------------------ PDF (pdfmake)

let pdfmakeReady;
async function loadPdfMake() {
  pdfmakeReady ??= (async () => {
    await loadScript(VENDOR + 'pdfmake.min.js');
    await loadScript(VENDOR + 'vfs_fonts.js');
    return window.pdfMake;
  })();
  return pdfmakeReady;
}

export function pdfNeedsPrint(md, meta) {
  return needsComplexScript(md + meta.title);
}

export async function downloadPdf(md, meta) {
  const pdfMake = await loadPdfMake();
  const content = [
    { text: 'SUMMARY', style: 'kicker' },
    { text: meta.title, style: 'title' },
    { text: metaLine(meta), style: 'meta' },
    { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 451, y2: 0, lineWidth: 0.6, lineColor: '#d6cfc4' }], margin: [0, 10, 0, 18] },
  ];
  const pdfRuns = (tokens) => runsOf(tokens).map((r) => {
    const node = { text: r.text };
    if (r.bold) node.bold = true;
    if (r.italics) node.italics = true;
    if (r.strike) node.decoration = 'lineThrough';
    if (r.code) node.background = '#f1ede6';
    if (r.link) { node.link = r.link; node.color = '#9a3412'; }
    return node;
  });
  const block = (t) => {
    switch (t.type) {
      case 'heading': return { text: pdfRuns(t.tokens), style: `h${Math.min(t.depth, 4)}` };
      case 'paragraph': return { text: pdfRuns(t.tokens), style: 'p' };
      case 'list': {
        const items = t.items.map((it) => {
          const stack = [];
          for (const c of it.tokens) {
            if (c.type === 'text') stack.push({ text: pdfRuns(c.tokens || [c]), style: 'li' });
            else { const b = block(c); if (b) stack.push(b); }
          }
          return stack.length === 1 ? stack[0] : { stack };
        });
        return t.ordered ? { ol: items, style: 'list', start: Number(t.start) || 1 } : { ul: items, style: 'list' };
      }
      case 'blockquote':
        return {
          table: { widths: [3, '*'], body: [[{ text: '', fillColor: '#c2410c' }, { stack: t.tokens.map(block).filter(Boolean), style: 'quote' }]] },
          layout: { hLineWidth: () => 0, vLineWidth: () => 0, paddingLeft: (i) => (i ? 12 : 0), paddingRight: () => 0, paddingTop: () => 2, paddingBottom: () => 2 },
          margin: [0, 4, 0, 10],
        };
      case 'hr': return { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 451, y2: 0, lineWidth: 0.5, lineColor: '#d6cfc4' }], margin: [0, 8, 0, 14] };
      case 'code': return { text: t.text, style: 'code' };
      case 'table': {
        const head = t.header.map((c) => ({ text: pdfRuns(c.tokens), bold: true, fillColor: '#f3efe8' }));
        const rows = t.rows.map((r) => r.map((c) => ({ text: pdfRuns(c.tokens) })));
        return { table: { headerRows: 1, widths: head.map(() => '*'), body: [head, ...rows] }, layout: 'lightHorizontalLines', style: 'table' };
      }
      case 'space': return null;
      default: return t.text ? { text: decode(t.text), style: 'p' } : null;
    }
  };
  for (const t of marked.lexer(md)) {
    const b = block(t);
    if (b) content.push(b);
  }
  const doc = {
    info: { title: `${meta.title} — Summary`, creator: 'Précis' },
    pageSize: 'A4',
    pageMargins: [72, 64, 72, 64],
    content,
    footer: (page, pages) => ({ text: `${page} / ${pages}`, alignment: 'center', fontSize: 8, color: '#9b9286', margin: [0, 24, 0, 0] }),
    defaultStyle: { font: 'Roboto', fontSize: 11, lineHeight: 1.45, color: '#1f1c18' },
    styles: {
      kicker: { fontSize: 8, bold: true, color: '#c2410c', characterSpacing: 1.5 },
      title: { fontSize: 22, bold: true, lineHeight: 1.15, margin: [0, 4, 0, 6] },
      meta: { fontSize: 9, color: '#6b645a' },
      h1: { fontSize: 17, bold: true, margin: [0, 14, 0, 6], lineHeight: 1.2 },
      h2: { fontSize: 14.5, bold: true, margin: [0, 12, 0, 5], lineHeight: 1.2 },
      h3: { fontSize: 12.5, bold: true, margin: [0, 10, 0, 4] },
      h4: { fontSize: 11.5, bold: true, italics: true, margin: [0, 8, 0, 3] },
      p: { margin: [0, 0, 0, 9], alignment: 'justify' },
      list: { margin: [0, 0, 0, 9] },
      li: { margin: [0, 0, 0, 3] },
      quote: { italics: true, color: '#4a443c' },
      code: { fontSize: 9.5, background: '#f1ede6', margin: [0, 0, 0, 9] },
      table: { fontSize: 9.5, margin: [0, 2, 0, 12] },
    },
  };
  const blob = await pdfMake.createPdf(doc).getBlob();
  save(blob, `${meta.stem}.pdf`);
}

// Fallback for scripts the embedded PDF font can't draw (Arabic, Urdu, Hindi, CJK…): the browser's
// own print engine renders every script correctly; choose "Save as PDF" in the print dialog.
export function printAsPdf(md, meta) {
  const html = standaloneHtml(md, meta);
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.appendChild(frame);
  frame.contentDocument.open();
  frame.contentDocument.write(html);
  frame.contentDocument.close();
  const go = () => {
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(() => frame.remove(), 60000);
  };
  if (frame.contentDocument.readyState === 'complete') setTimeout(go, 200);
  else frame.onload = go;
}

// ------------------------------------------------ Word (.docx)

let docxReady;
export async function downloadDocx(md, meta) {
  docxReady ??= import(VENDOR + 'docx.mjs');
  const D = await docxReady;
  const rtl = isRtl(md);
  const runs = (tokens, extra = {}) => runsOf(tokens).map((r) => new D.TextRun({
    text: r.text === '\n' ? '' : r.text,
    break: r.text === '\n' ? 1 : undefined,
    bold: r.bold || extra.bold,
    italics: r.italics || extra.italics,
    strike: r.strike,
    font: r.code ? 'Consolas' : undefined,
    color: r.link ? '9A3412' : extra.color,
    underline: r.link ? {} : undefined,
    rightToLeft: rtl || undefined,
  }));
  const paras = [];
  let listCount = 0;
  const P = (opts) => new D.Paragraph({ bidirectional: rtl || undefined, ...opts });
  const block = (t, level = 0, quote = false) => {
    switch (t.type) {
      case 'heading': {
        const H = [D.HeadingLevel.HEADING_1, D.HeadingLevel.HEADING_2, D.HeadingLevel.HEADING_3, D.HeadingLevel.HEADING_4][Math.min(t.depth, 4) - 1];
        paras.push(P({ heading: H, children: runs(t.tokens) }));
        break;
      }
      case 'paragraph':
        paras.push(P({ children: runs(t.tokens, quote ? { italics: true, color: '4A443C' } : {}), style: quote ? 'Quote' : undefined, spacing: { after: 160 } }));
        break;
      case 'list': {
        // Each ordered list gets its own numbering instance so it restarts at 1.
        const instance = ++listCount;
        t.items.forEach((it) => {
          let first = true;
          for (const c of it.tokens) {
            if (c.type === 'text' || c.type === 'paragraph') {
              paras.push(P({
                children: runs(c.tokens || [c]),
                ...(first
                  ? (t.ordered ? { numbering: { reference: 'precis-numbers', level, instance } } : { bullet: { level } })
                  : { indent: { left: 720 * (level + 1) } }),
                spacing: { after: 80 },
              }));
              first = false;
            } else if (c.type === 'list') block(c, level + 1, quote);
            else block(c, level, quote);
          }
        });
        break;
      }
      case 'blockquote':
        t.tokens.forEach((c) => block(c, level, true));
        break;
      case 'hr':
        paras.push(P({ children: [], border: { bottom: { style: D.BorderStyle.SINGLE, size: 6, color: 'D6CFC4', space: 1 } }, spacing: { after: 200 } }));
        break;
      case 'code':
        t.text.split('\n').forEach((line) => paras.push(P({ children: [new D.TextRun({ text: line, font: 'Consolas', size: 19 })] })));
        break;
      case 'table':
        [t.header, ...t.rows].forEach((row, ri) => {
          const children = [];
          row.forEach((cell, ci) => {
            if (ci) children.push(new D.TextRun({ text: '  |  ', color: '9B9286' }));
            children.push(...runs(cell.tokens, ri === 0 ? { bold: true } : {}));
          });
          paras.push(P({ children, spacing: { after: 60 } }));
        });
        break;
      case 'space': break;
      default:
        if (t.text) paras.push(P({ children: [new D.TextRun({ text: decode(t.text) })] }));
    }
  };
  for (const t of marked.lexer(md)) block(t);

  const doc = new D.Document({
    creator: 'Précis',
    title: `${meta.title} — Summary`,
    styles: {
      default: { document: { run: { font: 'Georgia', size: 23 }, paragraph: { spacing: { line: 300, lineRule: 'auto' } } } },
      paragraphStyles: [
        { id: 'PrecisTitle', name: 'Summary Title', basedOn: 'Normal', next: 'Normal', run: { size: 44, bold: true, font: 'Georgia' }, paragraph: { spacing: { before: 40, after: 100, line: 264, lineRule: 'auto' } } },
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 32, bold: true }, paragraph: { spacing: { before: 280, after: 120 } } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 28, bold: true }, paragraph: { spacing: { before: 240, after: 100 } } },
        { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 25, bold: true }, paragraph: { spacing: { before: 200, after: 80 } } },
        { id: 'Heading4', name: 'Heading 4', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 23, bold: true, italics: true }, paragraph: { spacing: { before: 160, after: 60 } } },
        { id: 'Quote', name: 'Quote', basedOn: 'Normal', run: { italics: true }, paragraph: { indent: { left: 567 }, border: { left: { style: D.BorderStyle.SINGLE, size: 12, color: 'C2410C', space: 8 } } } },
      ],
    },
    numbering: {
      config: [{
        reference: 'precis-numbers',
        levels: [0, 1, 2, 3].map((level) => ({
          level, format: [D.LevelFormat.DECIMAL, D.LevelFormat.LOWER_LETTER, D.LevelFormat.LOWER_ROMAN, D.LevelFormat.DECIMAL][level],
          text: `%${level + 1}.`, alignment: D.AlignmentType.START,
          style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
        })),
      }],
    },
    sections: [{
      properties: { page: { margin: { top: 1300, bottom: 1300, left: 1440, right: 1440 } } },
      footers: {
        default: new D.Footer({ children: [new D.Paragraph({ alignment: D.AlignmentType.CENTER, children: [new D.TextRun({ children: [D.PageNumber.CURRENT], size: 16, color: '9B9286' })] })] }),
      },
      children: [
        P({ children: [new D.TextRun({ text: 'SUMMARY', bold: true, size: 16, color: 'C2410C', characterSpacing: 40 })], spacing: { after: 60, line: 240, lineRule: 'auto' } }),
        P({ style: 'PrecisTitle', children: [new D.TextRun({ text: meta.title, rightToLeft: rtl || undefined })] }),
        P({ children: [new D.TextRun({ text: metaLine(meta), size: 18, color: '6B645A' })], border: { bottom: { style: D.BorderStyle.SINGLE, size: 6, color: 'D6CFC4', space: 8 } }, spacing: { after: 300 } }),
        ...paras,
      ],
    }],
  });
  const blob = await D.Packer.toBlob(doc);
  save(blob, `${meta.stem}.docx`);
}
