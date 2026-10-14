// Text of a file attached to a radiology input (modules.radiology).
//
// Files are read here in the browser and never uploaded: reports are patient
// data, and the pipeline needs the report's own lines, not the Markdown the
// documents service (apis/processFile.jsx) would make of it. The parsers are
// loaded only when a file of their type is attached.

export const MAX_FILE_SIZE_MB = 20;

const READERS = {
  pdf: readPdf,
  docx: readDocx,
  txt: readTxt,
};

// For the file picker; drag and drop is checked by readReportFile itself
export const ACCEPTED_FILES = ".pdf,.docx,.txt";

// `code` names the i18n message: radiology.file_error.<code>
export class ReportFileError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export async function readReportFile(file) {
  const ext = file.name.toLowerCase().split(".").pop();
  if (ext === "doc") throw new ReportFileError("legacy_doc");
  if (!(ext in READERS)) throw new ReportFileError("unsupported");
  if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) throw new ReportFileError("too_large");

  let text;
  try {
    text = await READERS[ext](file);
  } catch (error) {
    if (error instanceof ReportFileError) throw error;
    if (error?.name === "PasswordException") throw new ReportFileError("password");
    // The error only, never the file's content
    console.error("Could not read file:", error?.name, error?.message);
    throw new ReportFileError("failed");
  }

  // Unix line breaks as in the text box; drop blank lines around the text
  text = text.replace(/\r\n?/g, "\n").replace(/^(?:[ \t]*\n)+/, "").trimEnd();
  // A scanned document is only images
  if (text.trim() === "") throw new ReportFileError("no_text");
  return text;
}

async function readTxt(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  // "Unicode" text from Windows Notepad
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  // A binary file renamed to .txt
  if (bytes.includes(0)) throw new ReportFileError("unsupported");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Older Windows programs save German text as Windows-1252
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

// mammoth's own plain text drops line breaks within a paragraph (Shift+Enter),
// which reports use a lot, so take its HTML and keep one line per paragraph
async function readDocx(file) {
  const { default: mammoth } = await import("mammoth");
  const { value: html } = await mammoth.convertToHtml(
    { arrayBuffer: await file.arrayBuffer() },
    { ignoreEmptyParagraphs: false } // empty paragraphs are blank lines
  );
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
  const BLOCKS = "p, h1, h2, h3, h4, h5, h6, li";
  return [...doc.body.querySelectorAll(BLOCKS)]
    .filter((block) => !block.querySelector(BLOCKS)) // innermost only
    .map((block) => block.textContent)
    .join("\n");
}

// The legacy build also runs on the older browsers of clinic workstations
async function readPdf(file) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { default: workerUrl } = await import(
    "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"
  );
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  try {
    const pdf = await task.promise;
    const pages = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      pages.push(pageText(await page.getTextContent()));
    }
    return pages.join("\n\n");
  } finally {
    task.destroy(); // frees the worker
  }
}

// pdf.js gives positioned pieces of text and marks where a line ends. A blank
// line in the report shows only as a larger gap to the next line, so a gap of
// more than about one line becomes an empty line again.
function pageText(content) {
  let text = "";
  let lineStart = true;
  let lastY = null;
  let lastHeight = 0;
  for (const item of content.items) {
    if (typeof item.str !== "string") continue; // marked-content boundaries
    const y = item.transform[5];
    const height = item.height || Math.hypot(item.transform[2], item.transform[3]);
    if (lineStart && item.str.trim() !== "") {
      if (lastY !== null && Math.abs(lastY - y) > 1.8 * lastHeight) text += "\n";
      lastY = y;
      lastHeight = height;
      lineStart = false;
    }
    text += item.str;
    if (item.hasEOL) {
      text += "\n";
      lineStart = true;
    }
  }
  return text;
}
