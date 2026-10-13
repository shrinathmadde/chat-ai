// Radiology report inputs (modules.radiology).
//
// The UI collects an ordered list of inputs, each { kind, text }. On send they
// go to the report pipeline (apis/generateRadiologyReport.jsx), which returns
// the complete follow-up report. Pasted text is passed on verbatim: never trim
// or re-wrap it, the report layout carries meaning.

// Kinds in the order they appear in the UI. The pipeline needs all three.
export const REPORT_KINDS = {
  previous_report: { multiple: true },
  dictation: { multiple: false },
  assessment: { multiple: false },
};

const KIND_ORDER = Object.keys(REPORT_KINDS);

// Insert a new input after the existing ones of the same or earlier kind, so
// the list always reads previous reports → dictation → assessment.
export function insertInput(inputs, input) {
  const rank = KIND_ORDER.indexOf(input.kind);
  const at = inputs.findIndex((other) => KIND_ORDER.indexOf(other.kind) > rank);
  return at === -1
    ? [...inputs, input]
    : [...inputs.slice(0, at), input, ...inputs.slice(at)];
}

// The pipeline edits ONE previous report: the one added last. Which report
// should be the baseline is still open; change it here.
export function baselineIndex(inputs) {
  return inputs.findLastIndex((input) => input.kind === "previous_report");
}

// Kinds the pipeline needs that are still missing or empty
export function missingKinds(inputs) {
  return KIND_ORDER.filter(
    (kind) => !inputs.some((input) => input.kind === kind && input.text.trim() !== "")
  );
}

// Request body for the pipeline
export function buildReportRequest(inputs) {
  const textOf = (kind) => inputs.find((input) => input.kind === kind)?.text || "";
  return {
    previous_report: inputs[baselineIndex(inputs)]?.text || "",
    dictation: textOf("dictation"),
    assessment: textOf("assessment"),
  };
}

const HEADINGS = {
  previous_report: "VORBEFUND",
  dictation: "DIKTAT (nur Änderungen)",
  assessment: "BEURTEILUNG (diktiert)",
};

// Text of the user message: every input with a heading, verbatim. It is what
// a later normal chat message in this conversation sees as history, and what
// "Show inputs" and the export show.
export function formatInputs(inputs) {
  const reports = inputs.filter((input) => input.kind === "previous_report").length;
  let reportCount = 0;
  return inputs
    .map((input) => {
      let heading = HEADINGS[input.kind];
      if (input.kind === "previous_report" && reports > 1) heading += ` ${++reportCount}`;
      return `${heading}:\n---\n${input.text}\n---`;
    })
    .join("\n\n");
}

// Chip labels, e.g. "Vorbefund 2". Previous reports are numbered in the order
// they were added.
export function getInputLabels(kinds, t) {
  let reportCount = 0;
  return kinds.map((kind) =>
    kind === "previous_report"
      ? `${t("radiology.previous_report")} ${++reportCount}`
      : t(`radiology.${kind}`)
  );
}
