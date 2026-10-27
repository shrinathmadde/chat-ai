// Report feedback (modules.radiologyFeedback), through the back end's
// /radiology/feedback: stores a report the radiologist chose to share for
// evaluation, or withdraws it. The record's `id` is generated in the browser
// and kept with the report, so sending again replaces the stored copy.

async function request(path, options) {
  const response = await fetch(
    `${import.meta.env.VITE_BACKEND_ENDPOINT}/radiology/feedback${path}`,
    options
  );
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      result.error || `Report feedback failed with status ${response.status}`
    );
  }
  return result;
}

export function sendReportFeedback(record) {
  return request("", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(record),
  });
}

export function withdrawReportFeedback(id) {
  return request(`/${encodeURIComponent(id)}`, { method: "DELETE" });
}
