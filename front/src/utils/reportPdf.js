// Follow-up report as a PDF to send on (modules.radiology).
//
// Built here in the browser, so the report never leaves this computer. The
// text is set line by line as in the report editor, in a monospaced font, so
// indentation and the space-aligned columns of measurement tables stay as they
// are. jsPDF's own fonts can't draw ≤, ≥ or → (the whole line comes out
// garbled), so Liberation Mono is embedded; it is fetched on the first export.

import { jsPDF } from "jspdf";
import fontUrl from "../assets/fonts/LiberationMono-Regular.ttf?url";

const FONT = "LiberationMono";
const FONT_FILE = "LiberationMono-Regular.ttf";
const FONT_SIZE = 10; // pt: 80 characters per line on A4
const LINE_HEIGHT = 1.4; // times the font size
const MARGIN = 20; // mm
const TAB_SIZE = 8; // as in the text box
const MM_PER_PT = 25.4 / 72;

let fontData; // base64

async function loadFont() {
  if (!fontData) {
    const response = await fetch(fontUrl);
    if (!response.ok) throw new Error(`Font not loaded: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    fontData = btoa(binary);
  }
  return fontData;
}

// Each tab up to the next tab stop, so columns stay where they were
function expandTabs(line) {
  return line.replace(
    /([^\t]*)\t/g,
    (_, before) => before + " ".repeat(TAB_SIZE - (before.length % TAB_SIZE))
  );
}

// Break a line that is too long after its last word that fits, as the text box
// does; a word longer than a whole line is cut
function wrap(line, columns) {
  const rows = [];
  line = line.trimEnd();
  while (line.length > columns) {
    const indent = line.match(/^ */)[0].length;
    let cut = line.lastIndexOf(" ", columns);
    if (cut <= indent) cut = columns;
    rows.push(line.slice(0, cut).trimEnd());
    line = line.slice(cut).trimStart();
  }
  rows.push(line);
  return rows;
}

// `pageLabel(page, pages)` gives the footer, e.g. "Seite 1 von 2"
export async function downloadReportPdf(text, { title, fileName, pageLabel }) {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  doc.addFileToVFS(FONT_FILE, await loadFont());
  doc.addFont(FONT_FILE, FONT, "normal");
  doc.setFont(FONT, "normal");
  // Nothing from the report in the metadata
  doc.setProperties({ title, creator: "Chat AI" });

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  doc.setFontSize(FONT_SIZE);
  // Every character of a monospaced font is equally wide
  const columns = Math.floor((pageWidth - 2 * MARGIN) / doc.getTextWidth("0"));
  const lineHeight = FONT_SIZE * LINE_HEIGHT * MM_PER_PT;

  // Blank lines around the report would only add space or an empty page
  const rows = text
    .replace(/\r\n?/g, "\n")
    .replace(/^(?:[ \t]*\n)+/, "")
    .trimEnd()
    .split("\n")
    .flatMap((line) => wrap(expandTabs(line), columns));

  let y = MARGIN;
  for (const row of rows) {
    if (y + lineHeight > pageHeight - MARGIN) {
      doc.addPage();
      y = MARGIN;
    }
    doc.text(row, MARGIN, y, { baseline: "top" });
    y += lineHeight;
  }

  const pages = doc.getNumberOfPages();
  doc.setFontSize(8);
  doc.setTextColor(120);
  for (let page = 1; page <= pages; page++) {
    doc.setPage(page);
    doc.text(pageLabel(page, pages), pageWidth / 2, pageHeight - MARGIN / 2, {
      align: "center",
    });
  }

  doc.save(fileName);
}
