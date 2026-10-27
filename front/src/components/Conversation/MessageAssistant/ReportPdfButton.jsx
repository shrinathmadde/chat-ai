import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FileDown } from "lucide-react";
import { useToast } from "../../../hooks/useToast";
import { downloadReportPdf } from "../../../utils/reportPdf";

const pad = (n) => String(n).padStart(2, "0");

// e.g. 2026-10-27-1432, so reports downloaded one after another don't clash
function timestamp(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(
    date.getHours()
  )}${pad(date.getMinutes())}`;
}

// Downloads the report, as it stands with the radiologist's edits, as a PDF to
// send on. Clicking here takes the focus from the report editor first, which
// saves it, so `text` is the current version.
export default function ReportPdfButton({ text }) {
  const { t } = useTranslation();
  const { notifyError } = useToast();
  const [busy, setBusy] = useState(false);

  const download = async () => {
    setBusy(true);
    try {
      await downloadReportPdf(text, {
        title: t("radiology.report"),
        fileName: `${t("radiology.pdf.file_name")}-${timestamp()}.pdf`,
        pageLabel: (page, pages) => t("radiology.pdf.page", { page, pages }),
      });
    } catch (error) {
      // The error only, never the report
      console.error("Could not create PDF:", error?.name, error?.message);
      notifyError(t("radiology.pdf.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      onClick={download}
      disabled={busy}
      title={t("radiology.pdf.button_hint")}
      className="flex items-center gap-1 text-xs text-tertiary cursor-pointer whitespace-nowrap disabled:cursor-wait disabled:opacity-60"
    >
      <FileDown className="h-4 w-4" />
      {t("radiology.pdf.button")}
    </button>
  );
}
