import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp } from "@carbon/icons-react";
import { baselineIndex, getInputLabels } from "../../../utils/radiologyInputs";

// User message made of radiology inputs: lists which inputs went in and shows
// their text on demand.
export default function RadiologyMessageText({ message }) {
  const { t } = useTranslation();
  const [showText, setShowText] = useState(false);
  // Messages from the earlier prompt mode only stored the kinds, as `parts`
  const { inputs, parts } = message.meta.radiology;
  const kinds = inputs ? inputs.map((input) => input.kind) : parts || [];
  const labels = getInputLabels(kinds, t);
  const baseline = inputs ? baselineIndex(inputs) : -1;
  const isUnused = (i) => inputs && kinds[i] === "previous_report" && i !== baseline;

  return (
    <div className="flex flex-col gap-2 flex-grow min-w-0 text-sm">
      <div className="flex flex-wrap gap-1.5">
        {labels.map((label, i) => (
          <span
            key={i}
            className={`px-2 py-0.5 rounded-full text-xs font-medium
                     bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200
                     ${isUnused(i) ? "opacity-50" : ""}`}
            title={isUnused(i) ? t("radiology.not_used") : undefined}
          >
            {label}
          </span>
        ))}
      </div>
      <button
        className="flex items-center gap-1 text-xs text-tertiary w-fit cursor-pointer"
        onClick={() => setShowText((show) => !show)}
      >
        {showText ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        {t(showText ? "radiology.hide_inputs" : "radiology.show_inputs")}
      </button>
      {showText && (
        <pre
          className="font-sans text-sm max-h-[60vh] overflow-y-auto"
          style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
        >
          {message.content[0]?.text}
        </pre>
      )}
    </div>
  );
}
