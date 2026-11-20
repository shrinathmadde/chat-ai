// Builds the German user guide, front/public/anleitung.pdf, from screenshots of
// the running app. Rerun it after the interface changes.
//
// Needs, on this machine: front (:8080), back (:8081) and parser (:8082)
// running with modules.radiology and modules.radiologyFeedback on, and Google
// Chrome. Then, from front/:   node guide/make-guide.mjs
//
// The report shown is made up (SAMPLE below); never put a real report here.
// Generating it takes one model call, so a run takes a minute or more.
//
// How it works: Chrome is driven over its DevTools protocol (no extra
// packages). The script clicks through the app like a user, takes screenshots
// and notes where each button is, then lays out the pages (PAGES below: the
// text of the guide) with numbered markers on the screenshots and has Chrome
// print them to PDF.
//
// Options: GUIDE_APP_URL (default http://localhost:8080/), GUIDE_OUT (the PDF),
// CHROME (the browser binary), --keep <dir> to also save the screenshots, and
// --from <dir> to build the PDF from screenshots saved that way, without the
// app: for changing only the text or layout (no servers, no model call).

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = process.env.GUIDE_APP_URL || "http://localhost:8080/";
const OUT = process.env.GUIDE_OUT || path.join(HERE, "../public/anleitung.pdf");
const CHROME = process.env.CHROME || "google-chrome";
const PORT = 9334;
const SCALE = 2; // screenshots at twice the resolution, sharp when printed
const SCREEN = { w: 1024, h: 640 };

// A made-up previous report and dictation.
const SAMPLE = {
  previous: `CT Thorax/Abdomen mit Kontrastmittel

Befund:
Lunge: Kein Rundherd. Kein Pleuraerguss.
Lymphknoten: Keine vergrößerten Lymphknoten.
Leber: Hypodense Läsion in Segment 7 (Serie 3, Bild 45), 14 mm, größenkonstant zur Voruntersuchung, vereinbar mit Metastase.
Skelett: Keine suspekten ossären Läsionen.

Beurteilung:
1. Größenkonstante Lebermetastase in Segment 7.
2. Kein Nachweis neuer Metastasen.`,
  dictation:
    "Lebermetastase Segment 7 jetzt 19 mm, größenprogredient. Neu kleiner Pleuraerguss rechts.",
};

// The guide's text. Each item is a numbered marker on the screenshot: `el`
// names an element found in capture(), `at` the corner its number sits on.
const PAGES = [
  {
    shot: "main",
    title: "Folgebefund vorbereiten",
    lead: "Aus dem Vorbefund und Ihrem Diktat erstellt das Modell den Folgebefund. Es schreibt den Vorbefund nicht neu, sondern trägt nur die diktierten Änderungen ein.",
    items: [
      { el: "newChat", at: "right", title: "Neuer Chat",
        text: "Für jede Patientin und jeden Patienten einen neuen Chat beginnen. Chats werden nur in Ihrem Browser gespeichert." },
      { el: "chips", at: "tl", title: "Vorbefund und Diktat",
        text: "Mit „+ Vorbefund“ und „+ Diktat“ den Text einfügen (Seite 2). Das Diktat enthält nur die Änderungen gegenüber dem Vorbefund. Ein Klick auf eine Eingabe öffnet sie zum Ansehen oder Ändern, das × entfernt sie." },
      { el: "assessment", at: "above", title: "Beurteilung (optional)",
        text: "Leer lassen: Das Modell aktualisiert die Beurteilung des Vorbefunds. Eine eingegebene Beurteilung wird unverändert übernommen." },
      { el: "prompt", at: "tl", title: "Hinweise an das Modell (optional)",
        text: "Zum Beispiel „Diktat in ganzen Sätzen ausformulieren“. Befunde gehören ins Diktat, nicht hierher." },
      { el: "mic", at: "right", title: "Mikrofon",
        text: "Diktiert in das Textfeld, in dem zuletzt der Cursor stand: hier in die Hinweise, nach dem Erstellen auch direkt in den Befund (Seite 3). Nochmals klicken beendet die Aufnahme." },
      { el: "model", at: "tl", title: "Modell",
        text: "Wählt das Sprachmodell. Mit großen Modellen kann das Erstellen einige Minuten dauern." },
      { el: "lock", at: "above", title: "Datenschutz-Anzeige",
        text: "Grünes Schloss: Die Daten werden auf Servern der GWDG verarbeitet und verlassen die GWDG nicht. Erscheint stattdessen ein gelbes Warnzeichen, keine Patientendaten senden." },
      { el: "send", at: "above", title: "Senden",
        text: "Erstellt den Folgebefund." },
    ],
  },
  {
    shot: "dialog",
    title: "Text einfügen oder diktieren",
    lead: "„+ Vorbefund“, „+ Diktat“ und „+ Beurteilung“ öffnen dieses Fenster. Der Text wird so übernommen, wie er hier steht.",
    items: [
      { el: "text", at: "tl", title: "Textfeld",
        text: "Text einfügen (Strg+V) oder tippen. Kopf- und Fußzeilen und alles, was nicht zum Befund gehört, bitte entfernen." },
      { el: "mic", at: "tl", title: "Mikrofon",
        text: "Diktieren; nochmals klicken beendet die Aufnahme. Die Spracherkennung läuft bei der GWDG." },
      { el: "attach", at: "tr", title: "Datei",
        text: "PDF-, Word- (.docx) oder Textdatei anhängen oder in das Textfeld ziehen. Die Datei wird auf Ihrem Computer gelesen und nicht hochgeladen." },
      { el: "ok", at: "tr", title: "OK",
        text: "Übernimmt den Text (Tastatur: Strg+Enter)." },
    ],
    tip: "Mehrere Vorbefunde: Verwendet wird nur der zuletzt hinzugefügte, die anderen werden grau angezeigt.",
  },
  {
    shot: "report",
    title: "Befund prüfen und weitergeben",
    lead: "Der Folgebefund erscheint unter Ihren Eingaben. Das Modell kann Fehler machen: Prüfen Sie jeden Befund vollständig, bevor Sie ihn verwenden.",
    items: [
      { el: "inputs", at: "left", title: "Eingaben anzeigen",
        text: "Zeigt Vorbefund, Diktat und Hinweise, aus denen der Befund erstellt wurde." },
      { el: "hint", at: "left", title: "Hinweis zur Beurteilung",
        text: "Erscheint, wenn keine Beurteilung angegeben war und das Modell sie selbst aktualisiert hat. Dann die Beurteilung besonders sorgfältig prüfen, auch das Verlaufsurteil." },
      { el: "editor", at: "left", title: "Folgebefund",
        text: "Gegenüber dem Vorbefund geänderter Text ist farbig markiert. In den Text klicken, um ihn direkt zu bearbeiten; gespeichert wird beim Klick außerhalb. Nach einer Änderung stellt „Generierten Befund wiederherstellen“ die Fassung des Modells wieder her." },
      { el: "showRemoved", at: "left", title: "Entfernten Text anzeigen",
        text: "Zeigt durchgestrichen, was aus dem Vorbefund entfernt wurde. „Zurück zum Bearbeiten“ schließt diese Ansicht." },
      { el: "copy", at: "left", title: "Kopieren",
        text: "Kopiert den Befund mit Ihren Änderungen, z. B. zum Einfügen in Ihr Befundsystem." },
      { el: "pdf", at: "left", title: "PDF herunterladen",
        text: "Speichert den Befund mit Ihren Änderungen als PDF. Es wird in Ihrem Browser erzeugt." },
      { el: "feedback", at: "above", title: "Feedback",
        text: "Bewertung und Kommentar zu diesem Befund. Gesendet wird erst, wenn Sie der Weitergabe zustimmen; Angaben zu Ihrer Person werden nicht gespeichert." },
      { el: "mic", at: "right", title: "Mikrofon im Befund",
        text: "Erst in den Befund klicken, dann diktieren: Der Text wird an der Cursorposition eingefügt." },
    ],
  },
];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Chrome over the DevTools protocol -------------------------------------

async function launch() {
  const profile = mkdtempSync(path.join(tmpdir(), "guide-chrome-"));
  const proc = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--hide-scrollbars",
    `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, "about:blank",
  ], { stdio: "ignore" });
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      target = list.find((t) => t.type === "page");
    } catch { await wait(100); }
  }
  if (!target) throw new Error(`Chrome did not start (${CHROME})`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    // The page's errors and failed requests, to see why a run fails
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      console.error("[page]", msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 500));
    } else if (msg.method === "Runtime.exceptionThrown") {
      console.error("[page]", msg.params.exceptionDetails.exception?.description?.slice(0, 500));
    } else if (msg.method === "Network.loadingFailed" && !msg.params.canceled) {
      console.error("[network]", msg.params.errorText, msg.params.requestId);
    } else if (msg.method === "Network.responseReceived" && msg.params.response.status >= 400) {
      console.error("[network]", msg.params.response.status, msg.params.response.url);
    }
    if (!pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const close = async () => {
    ws.close();
    const exited = new Promise((r) => proc.once("exit", r));
    proc.kill();
    await exited;
    // Chrome's helper processes may still be writing for a moment
    await wait(500);
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 5 }); } catch { /* temp dir, harmless */ }
  };
  return { send, close };
}

// Finding elements: by CSS selector, optionally the one whose text, aria-label,
// title or placeholder matches. rect() gives its position in CSS pixels.
const FIND = `
  const label = (el) => [el.textContent, el.getAttribute("aria-label"), el.getAttribute("title"), el.getAttribute("placeholder")].join(" ");
  const find = (sel, re) => [...document.querySelectorAll(sel)]
    .find((el) => el.getClientRects().length && (!re || new RegExp(re).test(label(el))));
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height }; };
  const union = (els) => { const rs = els.filter(Boolean).map(rect); if (!rs.length) return null;
    const x = Math.min(...rs.map((r) => r.x)), y = Math.min(...rs.map((r) => r.y));
    return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y }; };
  const click = (sel, re) => { const el = find(sel, re); if (!el) throw new Error("not found: " + sel + " " + (re || "")); el.click(); return true; };
  // The send "button" is an icon (components/Prompt/SendButton.jsx), last in the prompt's button row
  const sendIcon = () => document.querySelector(".prompt-area .grid > div:last-child svg");
  const dialog = () => find("textarea", "Text hier einfügen")?.closest(".rounded-2xl.shadow-lg");
`;

function pageHelpers(send) {
  // Runs an expression in the page, with the helpers in FIND
  const run = async (expr) => {
    const res = await send("Runtime.evaluate", {
      expression: `(() => { ${FIND}; return (${expr}); })()`,
      returnByValue: true, awaitPromise: true,
    });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || expr);
    return res.result.value;
  };
  const until = async (expr, what, timeout = 20000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await run(`!!(${expr})`)) return;
      await wait(250);
    }
    throw new Error(`Timed out waiting for ${what}`);
  };
  const viewport = (width, height) =>
    send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: SCALE, mobile: false });
  const screenshot = async (clip) => {
    const { data } = await send("Page.captureScreenshot", {
      format: "png", ...(clip && { clip: { ...clip, scale: 1 } }),
    });
    return `data:image/png;base64,${data}`;
  };
  return { run, until, viewport, screenshot };
}

// --- Clicking through the app ----------------------------------------------

async function capture(browser) {
  const { send } = browser;
  const { run, until, viewport, screenshot } = pageHelpers(send);
  const shots = {};
  // A screenshot of the area `box` (the whole screen without), and where the
  // elements in `elements` (an expression giving { name: rect }) are in it
  const shoot = async (elements, box) => {
    const origin = box ? { x: box.x, y: box.y } : { x: 0, y: 0 };
    const size = box ? { w: box.w, h: box.h } : await run(`({ w: innerWidth, h: innerHeight })`);
    const image = await screenshot(box && { x: box.x, y: box.y, width: box.w, height: box.h });
    const found = await run(elements);
    for (const [name, r] of Object.entries(found)) {
      if (r) found[name] = { ...r, x: r.x - origin.x, y: r.y - origin.y };
    }
    return { image, size, elements: found };
  };

  try {
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Network.enable");
    await viewport(SCREEN.w, SCREEN.h);
    await send("Page.navigate", { url: `${APP}?lng=de` });
    await until(`find("button", "Tour überspringen")`, "the welcome dialog");
    await run(`click("button", "Tour überspringen")`);
    await until(`find("button", "^\\\\s*Vorbefund")`, "the report input buttons");

    // Opens an input's dialog and types `text` into it
    const openInput = async (kind, text) => {
      await run(`click("button", "^\\\\s*${kind}")`);
      await until(`dialog()`, `the ${kind} dialog`);
      await run(`find("textarea", "Text hier einfügen").focus()`);
      await send("Input.insertText", { text });
      await wait(400);
    };
    const confirmInput = async () => {
      await run(`click("button", "^\\\\s*OK\\\\s*$")`);
      await until(`!dialog()`, "the dialog to close");
    };

    // Page 2: the input dialog, with the previous report pasted in
    await openInput("Vorbefund", SAMPLE.previous);
    const pad = 6;
    const box = await run(`(() => { const r = rect(dialog()); return { x: r.x - ${pad}, y: r.y - ${pad}, w: r.w + ${2 * pad}, h: r.h + ${2 * pad} }; })()`);
    // (only buttons inside the dialog: the page's own mic is behind it)
    shots.dialog = await shoot(`(() => { const d = dialog();
      const inside = (re) => [...d.querySelectorAll("button")].find((b) => new RegExp(re).test(label(b)));
      return {
        text: rect(find("textarea", "Text hier einfügen")),
        mic: rect(inside("Diktieren")),
        attach: rect(inside("anhängen")),
        ok: rect(inside("^\\\\s*OK\\\\s*$")),
      }; })()`, box);
    await confirmInput();
    await openInput("Diktat", SAMPLE.dictation);
    await confirmInput();
    await wait(500);

    // Page 1: the main screen, ready to send
    shots.main = await shoot(`({
      newChat: rect(find("button", "Neuer Chat")),
      chips: union([...document.querySelectorAll('[title="Klicken zum Ansehen oder Bearbeiten"]')]),
      assessment: rect(find("button", "Beurteilung")),
      prompt: rect(find(".prompt-area textarea")),
      mic: rect(find("button", "Diktieren")),
      model: rect(find("button", "Modell wechseln")),
      lock: rect(document.querySelector(".prompt-area .grid > div:nth-child(2) > div:last-child")),
      send: rect(sendIcon()),
    })`);

    // Page 3: send, wait for the report, and show it from its top
    await run(`sendIcon().dispatchEvent(new MouseEvent("click", { bubbles: true }))`);
    await until(`find("p", "Befund wird erstellt")`, "the report request to start");
    await until(`find("button", "PDF herunterladen") || find("button", "Try Again|Erneut")`,
      "the generated report", 15 * 60000);
    if (await run(`!find("button", "PDF herunterladen")`)) throw new Error("The report could not be generated");
    await viewport(SCREEN.w, 860);
    await wait(800);
    await run(`find("button", "Eingaben anzeigen")?.scrollIntoView({ block: "start" })`);
    await wait(800);
    shots.report = await shoot(`({
      inputs: rect(find("button", "Eingaben anzeigen")),
      hint: rect(find("p", "^Es wurde keine Beurteilung")),
      editor: rect(find("[aria-label=Folgebefund]")?.parentElement),
      showRemoved: rect(find("button", "Entfernten Text anzeigen")),
      // the report's own copy button, in its row of buttons (not the inputs')
      copy: rect(find("button", "PDF herunterladen").closest(".group")?.querySelector('[title="Copy message"]')),
      pdf: rect(find("button", "PDF herunterladen")),
      feedback: rect(find("button", "Diesen Befund und Ihr Feedback")),
      mic: rect(find("button", "Diktieren")),
    })`);
    return shots;
  } catch (err) {
    // Show where it got stuck
    const debug = path.join(tmpdir(), "guide-error.png");
    writeFileSync(debug, Buffer.from((await screenshot()).split(",")[1], "base64"));
    console.error(`Failed; the screen at that moment: ${debug}`);
    throw err;
  }
}

// --- Laying out the pages ----------------------------------------------------

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function figure(shot, items) {
  const { w, h } = shot.size;
  const pct = (v, total) => `${((v / total) * 100).toFixed(3)}%`;
  const marks = items.map((item, i) => {
    const r = shot.elements[item.el];
    const p = 3; // the outline sits a little outside the element
    const box = { x: r.x - p, y: r.y - p, w: r.w + 2 * p, h: r.h + 2 * p };
    // Where the number sits: on a corner (tl, tr, bl, br) for large areas, or
    // beside the element (left, right, above, below), so it hides no text
    const at = item.at || "tl";
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    const [nx, ny, shift] = {
      tl: [box.x, box.y, "-50%, -50%"],
      tr: [box.x + box.w, box.y, "-50%, -50%"],
      bl: [box.x, box.y + box.h, "-50%, -50%"],
      br: [box.x + box.w, box.y + box.h, "-50%, -50%"],
      left: [box.x, cy, "calc(-100% - 1mm), -50%"],
      right: [box.x + box.w, cy, "1mm, -50%"],
      above: [cx, box.y, "-50%, calc(-100% - 1mm)"],
      below: [cx, box.y + box.h, "-50%, 1mm"],
    }[at];
    return `<div class="box" style="left:${pct(box.x, w)};top:${pct(box.y, h)};width:${pct(box.w, w)};height:${pct(box.h, h)}"></div>
      <div class="num" style="left:${pct(nx, w)};top:${pct(ny, h)};transform:translate(${shift})">${i + 1}</div>`;
  });
  return `<figure class="shot" style="aspect-ratio:${w}/${h}"><img src="${shot.image}">${marks.join("")}</figure>`;
}

function html(shots) {
  const logo = `data:image/svg+xml;base64,${readFileSync(path.join(HERE, "../src/assets/logos/chat_ai.svg")).toString("base64")}`;
  const pages = PAGES.map((page, n) => {
    const shot = shots[page.shot];
    // Only the items whose element is on the screen (the hint, for one, may not be)
    const items = page.items.filter((item) => {
      if (shot.elements[item.el]) return true;
      console.warn(`Not on the screenshot, left out: page ${n + 1}, "${item.title}"`);
      return false;
    });
    return `<section class="page ${page.shot}">
      <header><img class="logo" src="${logo}"><span class="suffix">for Radiologists</span><span class="doc">Kurzanleitung</span></header>
      <h2><span class="step">${n + 1}</span>${esc(page.title)}</h2>
      <p class="lead">${esc(page.lead)}</p>
      ${figure(shot, items)}
      <ol class="legend">${items.map((item, i) => `<li><span class="num">${i + 1}</span><div><b>${esc(item.title)}</b> ${esc(item.text)}</div></li>`).join("")}</ol>
      ${page.tip ? `<p class="tip">${esc(page.tip)}</p>` : ""}
      <footer><span>Chat AI for Radiologists · Kurzanleitung</span><span>Seite ${n + 1} von ${PAGES.length}</span></footer>
    </section>`;
  });
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>
    @page { size: A4; margin: 0; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: "Noto Sans", "DejaVu Sans", Arial, sans-serif; color: #1f2937; font-size: 10pt; line-height: 1.4; }
    .page { width: 210mm; height: 297mm; padding: 12mm 14mm 10mm; display: flex; flex-direction: column; break-after: page; }
    header { display: flex; align-items: center; gap: 3mm; padding-bottom: 3mm; border-bottom: 1px solid #e5e7eb; }
    header .logo { height: 9mm; }
    header .suffix { font-weight: 700; text-transform: uppercase; letter-spacing: .12em; color: #4b5563; font-size: 9pt; }
    header .doc { margin-left: auto; color: #6b7280; font-size: 9pt; }
    h2 { display: flex; align-items: center; gap: 3mm; font-size: 16pt; margin: 6mm 0 2mm; }
    h2 .step { display: grid; place-items: center; width: 9mm; height: 9mm; border-radius: 50%; background: #009EE0; color: white; font-size: 13pt; }
    .lead { margin: 0 0 4mm; color: #374151; }
    .shot { position: relative; margin: 0 auto 4mm; width: 100%; border: 1px solid #d1d5db; border-radius: 2mm; overflow: hidden; }
    .dialog .shot { width: 85%; }
    .shot img { display: block; width: 100%; height: 100%; }
    .box { position: absolute; border: 2px solid #E11D48; border-radius: 6px; }
    .num { position: absolute; display: grid; place-items: center; width: 6mm; height: 6mm; border-radius: 50%;
           background: #E11D48; color: white; font-weight: 700; font-size: 9pt; box-shadow: 0 0 0 1.5px white; }
    .legend { list-style: none; margin: 0 0 3mm; padding: 0; display: grid; gap: 1.6mm; }
    .legend li { display: flex; gap: 2.5mm; align-items: flex-start; }
    .legend .num { position: static; transform: none; flex: none; box-shadow: none; }
    .tip { margin: 4mm 0 0; padding: 2.5mm 3mm; background: #f0f9ff; border-left: 3px solid #009EE0; }
    footer { margin-top: auto; display: flex; justify-content: space-between; color: #9ca3af; font-size: 8pt; padding-top: 2mm; border-top: 1px solid #e5e7eb; }
  </style></head><body>${pages.join("")}</body></html>`;
}

async function printPdf(browser, doc) {
  const { send } = browser;
  const { run, until } = pageHelpers(send);
  await send("Emulation.clearDeviceMetricsOverride");
  await send("Page.navigate", { url: "about:blank" });
  await wait(300);
  const { frameTree } = await send("Page.getFrameTree");
  await send("Page.setDocumentContent", { frameId: frameTree.frame.id, html: doc });
  await until(`[...document.images].every((img) => img.complete) && document.fonts.status === "loaded"`, "the guide's images");
  const { data } = await send("Page.printToPDF", { preferCSSPageSize: true, printBackground: true });
  return Buffer.from(data, "base64");
}

// --- Main --------------------------------------------------------------------

const option = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
};

// Screenshots saved with --keep
function loadShots(dir) {
  const saved = JSON.parse(readFileSync(path.join(dir, "elements.json"), "utf8"));
  return Object.fromEntries(Object.entries(saved).map(([name, shot]) => [name, {
    ...shot,
    image: `data:image/png;base64,${readFileSync(path.join(dir, `${name}.png`)).toString("base64")}`,
  }]));
}

const browser = await launch();
try {
  const from = option("--from");
  const shots = from ? loadShots(from) : await capture(browser);
  const dir = option("--keep");
  if (dir) {
    for (const [name, shot] of Object.entries(shots)) {
      writeFileSync(path.join(dir, `${name}.png`), Buffer.from(shot.image.split(",")[1], "base64"));
    }
    writeFileSync(path.join(dir, "elements.json"), JSON.stringify(
      Object.fromEntries(Object.entries(shots).map(([k, v]) => [k, { size: v.size, elements: v.elements }])), null, 2));
    writeFileSync(path.join(dir, "guide.html"), html(shots));
  }
  writeFileSync(OUT, await printPdf(browser, html(shots)));
  console.log(`Written: ${OUT}`);
} finally {
  await browser.close();
}
