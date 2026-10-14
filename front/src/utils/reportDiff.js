// Changes between the previous report and the generated (or edited) follow-up
// report, for the highlights in the report editor (modules.radiology).
//
// Returns a list of segments { type: "same" | "added" | "removed", text }.
// The "same" + "added" texts joined in order give back `current` exactly, so
// they can be laid behind the editable text; "removed" texts are only shown in
// the read-only review view.

import { diffLines, diffWordsWithSpace } from "diff";

// Bounds the word diff of one changed block; a larger rewrite is shown as a
// whole-block change instead of freezing the page while typing
const MAX_WORD_EDITS = 1000;

export function diffReport(previous, current) {
  if (typeof previous !== "string" || typeof current !== "string") return null;

  // Lines first, then words inside the lines that changed: much faster than a
  // word diff of the whole report, and keeps changes within their lines
  const parts = [];
  const lines = diffLines(previous, current);
  for (let i = 0; i < lines.length; i++) {
    const part = lines[i];
    const next = lines[i + 1];
    if (part.removed && next?.added) {
      const words = diffWordsWithSpace(part.value, next.value, {
        maxEditLength: MAX_WORD_EDITS,
      });
      parts.push(...(words || [part, next]));
      i++;
    } else {
      parts.push(part);
    }
  }

  const segments = toSegments(parts);
  // Safety net: highlights that don't match the text would mark the wrong words
  const rebuilt = segments
    .filter((segment) => segment.type !== "removed")
    .map((segment) => segment.text)
    .join("");
  return rebuilt === current ? segments : null;
}

// A word diff marks "Kein Nachweis" → "Neu aufgetretener" as two changes with
// an unchanged space between them. Folding such short gaps into the change
// around them gives one readable highlight per phrase.
function isShortGap(text) {
  return !text.includes("\n") && text.trim().split(/\s+/).length <= 1;
}

function toSegments(parts) {
  // Group into runs of unchanged text and changes { removed, added }
  const runs = [];
  parts.forEach((part, i) => {
    let last = runs.at(-1);
    if (part.added || part.removed) {
      if (last?.type !== "change") {
        last = { type: "change", removed: "", added: "" };
        runs.push(last);
      }
      last[part.added ? "added" : "removed"] += part.value;
      return;
    }
    const next = parts[i + 1];
    if (last?.type === "change" && (next?.added || next?.removed) && isShortGap(part.value)) {
      last.removed += part.value;
      last.added += part.value;
      return;
    }
    runs.push({ type: "same", text: part.value });
  });

  const segments = [];
  for (const run of runs) {
    if (run.type === "same") {
      segments.push(run);
      continue;
    }
    if (run.removed) segments.push({ type: "removed", text: run.removed });
    if (run.added) segments.push({ type: "added", text: run.added });
  }
  return segments;
}
