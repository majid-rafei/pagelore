// Read user-supplied files (PDF, DOCX, plain text) entirely in the browser. Nothing is uploaded anywhere.
import { unzipSync, strFromU8 } from 'fflate';

const MAX_BYTES = 15 * 1024 * 1024;
const MAX_CHARS = 60000;

/** @returns {Promise<{ name: string, kind: string, text: string, pages?: number }>} */
export async function readDocument(file) {
  if (file.size > MAX_BYTES) throw new Error('The file is larger than 15 MB.');
  const name = file.name || 'file';
  const ext = name.toLowerCase().split('.').pop();
  let result;
  if (ext === 'pdf' || file.type === 'application/pdf') result = { kind: 'PDF', ...(await readPdf(file)) };
  else if (ext === 'docx') result = { kind: 'Word', text: readDocx(new Uint8Array(await file.arrayBuffer())) };
  else if (ext === 'doc') throw new Error('Old .doc files are not supported. Save the file as .docx or PDF and try again.');
  else if (['txt', 'md', 'csv', 'json', 'rtf'].includes(ext) || file.type.startsWith('text/')) result = { kind: 'Text', text: await file.text() };
  else throw new Error('Unsupported file type. Use PDF, DOCX or TXT.');

  const text = result.text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length < 20) {
    throw new Error(result.kind === 'PDF'
      ? 'No text could be read from this PDF. It is probably a scanned image; use a text-based PDF or DOCX.'
      : 'The file contains no readable text.');
  }
  return { ...result, name, text: text.slice(0, MAX_CHARS) };
}

async function readPdf(file) {
  // Loaded on demand so the panel doesn't pay for pdf.js until a PDF is attached.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { default: workerUrl } = await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const task = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false
  });
  const doc = await task.promise;
  const pages = [];
  for (let i = 1; i <= Math.min(doc.numPages, 40); i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let line = '';
    const lines = [];
    for (const item of content.items) {
      if (!('str' in item)) continue;
      line += item.str;
      if (item.hasEOL) { lines.push(line); line = ''; }
      else if (item.str && !/\s$/.test(item.str)) line += ' ';
    }
    if (line.trim()) lines.push(line);
    pages.push(lines.map((l) => l.replace(/\s+/g, ' ').trim()).join('\n'));
  }
  const numPages = doc.numPages;
  await task.destroy(); // frees the pdf.js worker
  return { text: pages.join('\n\n'), pages: numPages };
}

function readDocx(bytes) {
  let files;
  try {
    files = unzipSync(bytes, { filter: (f) => f.name === 'word/document.xml' });
  } catch {
    throw new Error('This .docx file could not be opened.');
  }
  const xml = files['word/document.xml'];
  if (!xml) throw new Error('This .docx file has no document body.');
  const dom = new DOMParser().parseFromString(strFromU8(xml), 'application/xml');
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const paragraphs = [];
  for (const p of dom.getElementsByTagNameNS(W, 'p')) {
    let text = '';
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.namespaceURI === W) {
          if (child.localName === 't') text += child.textContent;
          else if (child.localName === 'tab') text += '\t';
          else if (child.localName === 'br' || child.localName === 'cr') text += '\n';
          else if (child.localName !== 'p') walk(child); // nested paragraphs (text boxes) are visited separately
        } else if (child.nodeType === 1) {
          walk(child);
        }
      }
    };
    walk(p);
    paragraphs.push(text);
  }
  return paragraphs.join('\n');
}
