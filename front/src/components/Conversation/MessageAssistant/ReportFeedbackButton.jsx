import { useTranslation } from "react-i18next";
import { CircleCheck, MessageSquareShare } from "lucide-react";
import packageJson from "../../../../package.json";
import { useModal } from "../../../modals/ModalContext";
import { buildReportRequest } from "../../../utils/radiologyInputs";

// Opens the dialog in which the radiologist can share this report for
// evaluation (modules.radiologyFeedback). What was shared stays with the
// report in meta.radiology.feedback: { id, rating, comment, report },
// `report` being the text as sent, so later edits can be noticed.
export default function ReportFeedbackButton({ message, inputs, instructions, onChange }) {
  const { t } = useTranslation();
  const { openModal } = useModal();
  const radiology = message?.meta?.radiology ?? {};
  const feedback = radiology.feedback;
  const report = message?.content?.[0]?.text ?? "";
  const outdated = !!feedback && feedback.report !== report;

  // Everything stored besides the radiologist's own feedback, as it is now.
  // Clicking here takes the focus from the report editor first, which saves it.
  const buildCase = () => ({
    ...buildReportRequest(inputs, instructions),
    generated_report: radiology.generated ?? null,
    final_report: report,
    assessment_generated: !!radiology.assessment_generated,
    edit_log: radiology.edit_log ?? null,
    // Reports from before the model id was kept have only its display name
    model: radiology.model || message?.meta?.model || "",
    reasoning: radiology.reasoning ?? null,
    app_version: packageJson.version,
  });

  const label = !feedback
    ? t("radiology.feedback.button")
    : t(outdated ? "radiology.feedback.shared_outdated" : "radiology.feedback.shared");

  return (
    <button
      onClick={() =>
        openModal("reportFeedback", { feedback, reportCase: buildCase(), onChange })
      }
      title={t("radiology.feedback.button_hint")}
      className={`flex items-center gap-1 text-xs cursor-pointer whitespace-nowrap ${
        outdated ? "text-amber-700 dark:text-amber-400" : "text-tertiary"
      }`}
    >
      {feedback && !outdated ? (
        <CircleCheck className="h-4 w-4" />
      ) : (
        <MessageSquareShare className="h-4 w-4" />
      )}
      {label}
    </button>
  );
}
