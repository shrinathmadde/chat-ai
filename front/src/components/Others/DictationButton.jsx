import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Microphone } from "@carbon/icons-react";

import Tooltip from "./Tooltip";
import { useDictation } from "../../hooks/useDictation";

// Round microphone button that dictates into a text field: press to record,
// press again to stop, and onText receives the transcript. Unmounting it
// drops a running recording. onBusyChange(true) while it records or
// transcribes.
export default function DictationButton({ onText, onBusyChange }) {
  const { t } = useTranslation();
  const dictation = useDictation(onText);
  const { status } = dictation;

  useEffect(() => {
    onBusyChange?.(status !== "idle");
  }, [status]);
  useEffect(() => () => onBusyChange?.(false), []);

  const label = {
    idle: t("radiology.dictate"),
    recording: t("radiology.dictate_stop"),
    transcribing: t("radiology.transcribing"),
  }[status];

  return (
    <Tooltip text={label}>
      <button
        type="button"
        aria-label={label}
        className={`h-[30px] w-[30px] flex-shrink-0 rounded-full flex items-center justify-center
                 cursor-pointer transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                   status === "recording"
                     ? "bg-red-500 hover:bg-red-600 animate-pulse"
                     : "bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600"
                 }`}
        onClick={status === "recording" ? dictation.stop : dictation.start}
        disabled={status === "transcribing"}
      >
        {status === "idle" && <Microphone size={18} className="text-tertiary" />}
        {status === "recording" && <span className="w-3 h-3 bg-white rounded-sm" />}
        {status === "transcribing" && (
          <span className="w-4 h-4 border-2 border-tertiary border-t-transparent rounded-full animate-spin" />
        )}
      </button>
    </Tooltip>
  );
}
