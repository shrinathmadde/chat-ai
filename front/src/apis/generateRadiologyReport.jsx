// Follow-up report from the parser pipeline (modules.radiology), through the
// back end's /radiology/report. The report arrives in one piece, after several
// minutes for large reasoning models, so there is no timeout here: the back
// end bounds the request, and the abort button cancels it.

// Controller for the abort button, as in chatCompletions
let controller = new AbortController();

// `reasoning` holds the thinking settings from getReasoningParams, as for a
// normal chat completion. `instructions`: what the radiologist typed in the
// text box for the model, empty if nothing.
export default async function generateRadiologyReport({
  previous_report,
  dictation,
  assessment,
  instructions,
  model,
  reasoning,
}) {
  let response;
  try {
    response = await fetch(
      `${import.meta.env.VITE_BACKEND_ENDPOINT}/radiology/report`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ previous_report, dictation, assessment, instructions, model, reasoning }),
        signal: controller.signal,
      }
    );
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Request aborted.");
    throw error;
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      result.error || `Report generation failed with status ${response.status}`
    );
    error.status = response.status;
    throw error;
  }
  return result; // { report, edit_log, sections, usage, assessment_generated }
}

export function abortRadiologyReport() {
  controller.abort();
  controller = new AbortController();
}
