import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Microphone } from "@carbon/icons-react";
import { ChevronDown, ChevronRight, ThumbsDown, ThumbsUp } from "lucide-react";
import { v4 as uuidv4 } from "uuid";
import BaseModal from "../BaseModal";
import Tooltip from "../../components/Others/Tooltip";
import { insertTranscript, useDictation } from "../../hooks/useDictation";
import { useToast } from "../../hooks/useToast";
import {
  sendReportFeedback,
  withdrawReportFeedback,
} from "../../apis/reportFeedback";

// The text box's text with dictated text where the cursor is, replacing any
// selection
const withDictation = ({ value, selectionStart, selectionEnd }, transcript) =>
  insertTranscript(value, selectionStart, selectionEnd, transcript).text;

// Comment box that can also be dictated. Grammarly and the browser's spell
// check stay out: comments may quote the report.
function DictationField({ label, placeholder, value, onChange, textareaRef, dictation, disabled }) {
  const { t } = useTranslation();
  const id = useId();
  const dictationLabel = {
    idle: t("radiology.dictate"),
    recording: t("radiology.dictate_stop"),
    transcribing: t("radiology.transcribing"),
  }[dictation.status];

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-gray-700 dark:text-gray-300">
        {label}
      </label>
      <div className="flex items-start gap-2">
        <textarea
          id={id}
          ref={textareaRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          rows={4}
          spellCheck={false}
          data-gramm="false"
          data-gramm_editor="false"
          data-enable-grammarly="false"
          className="flex-1 p-2 text-sm resize-y border dark:border-border_dark rounded-lg
                   bg-white dark:bg-black text-black dark:text-white
                   focus:outline-none focus:ring-2 focus:ring-tertiary"
        />
        <Tooltip text={dictationLabel}>
          <button
            type="button"
            aria-label={dictationLabel}
            className={`h-9 w-9 flex-shrink-0 rounded-full flex items-center justify-center
                     cursor-pointer transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                       dictation.status === "recording"
                         ? "bg-red-500 hover:bg-red-600 animate-pulse"
                         : "bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700"
                     }`}
            onClick={dictation.status === "recording" ? dictation.stop : dictation.start}
            disabled={disabled || dictation.status === "transcribing"}
          >
            {dictation.status === "idle" && <Microphone size={18} className="text-tertiary" />}
            {dictation.status === "recording" && <span className="w-3 h-3 bg-white rounded-sm" />}
            {dictation.status === "transcribing" && (
              <span className="w-4 h-4 border-2 border-tertiary border-t-transparent rounded-full animate-spin" />
            )}
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

// Asks the radiologist whether this report may be stored for evaluation,
// together with a thumbs up/down and comments. Nothing is sent before they
// agree and press Send; a shared report can be sent again after further
// edits (same id, so the stored copy is replaced) or withdrawn.
export default function ReportFeedbackModal({ isOpen, onClose, feedback, reportCase, onChange }) {
  const { t } = useTranslation();
  const { notifySuccess } = useToast();
  const [rating, setRating] = useState(feedback?.rating ?? null);
  const [comment, setComment] = useState(feedback?.comment ?? "");
  const [consent, setConsent] = useState(!!feedback);
  const [showData, setShowData] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);

  const commentRef = useRef(null);
  const dictation = useDictation((text) =>
    setComment(withDictation(commentRef.current, text))
  );
  const busy = sending || dictation.status !== "idle";
  const outdated = !!feedback && feedback.report !== reportCase.final_report;

  const send = async () => {
    if (!consent || busy) return;
    setSending(true);
    setError(null);
    const id = feedback?.id ?? uuidv4();
    try {
      await sendReportFeedback({ id, rating, comment, ...reportCase });
      onChange({ id, rating, comment, report: reportCase.final_report });
      notifySuccess(t("radiology.feedback.sent"));
      onClose();
    } catch (err) {
      setError(t("radiology.feedback.failed", { error: err.message }));
      setSending(false);
    }
  };

  const withdraw = async () => {
    if (busy) return;
    setSending(true);
    setError(null);
    try {
      await withdrawReportFeedback(feedback.id);
      onChange(undefined);
      notifySuccess(t("radiology.feedback.withdrawn"));
      onClose();
    } catch (err) {
      setError(t("radiology.feedback.withdraw_failed", { error: err.message }));
      setSending(false);
    }
  };

  const thumb = (value, Icon, labelKey) => (
    <button
      type="button"
      aria-pressed={rating === value}
      aria-label={t(labelKey)}
      title={t(labelKey)}
      onClick={() => setRating((current) => (current === value ? null : value))}
      className={`p-2 rounded-full cursor-pointer transition-colors ${
        rating === value
          ? "bg-tertiary text-white"
          : "bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 text-tertiary"
      }`}
    >
      <Icon className="h-5 w-5" />
    </button>
  );

  // What is stored besides the feedback above, shown on request
  const storedTexts = [
    ["radiology.previous_report", reportCase.previous_report],
    ["radiology.dictation", reportCase.dictation],
    ["radiology.assessment", reportCase.assessment || t("radiology.feedback.none_given")],
    ...(reportCase.instructions ? [["radiology.instructions", reportCase.instructions]] : []),
    ["radiology.feedback.generated_report", reportCase.generated_report ?? t("radiology.feedback.not_available")],
    ["radiology.feedback.final_report", reportCase.final_report],
  ];

  return (
    <BaseModal
      isOpen={isOpen}
      onClose={onClose}
      titleKey="radiology.feedback.title"
      maxWidth="max-w-2xl"
      // Escape or a click outside must not drop a running dictation or request
      isForced={busy}
    >
      <div className="flex flex-col gap-4 text-sm text-black dark:text-white">
        <p className="text-xs text-gray-600 dark:text-gray-300">{t("radiology.feedback.intro")}</p>
        {outdated && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            {t("radiology.feedback.outdated_hint")}
          </p>
        )}

        <div className="flex items-center gap-3">
          <span className="text-xs font-medium text-gray-700 dark:text-gray-300">
            {t("radiology.feedback.rating")}
          </span>
          {thumb(1, ThumbsUp, "radiology.feedback.good")}
          {thumb(-1, ThumbsDown, "radiology.feedback.bad")}
        </div>

        <DictationField
          label={t("radiology.feedback.comment")}
          placeholder={t("radiology.feedback.comment_placeholder")}
          value={comment}
          onChange={setComment}
          textareaRef={commentRef}
          dictation={dictation}
          disabled={sending}
        />

        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setShowData((show) => !show)}
            className="flex items-center gap-1 self-start text-xs text-tertiary cursor-pointer"
          >
            {showData ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            {t("radiology.feedback.show_data")}
          </button>
          {showData && (
            <div
              translate="no"
              className="flex flex-col gap-3 max-h-[40vh] overflow-y-auto p-3 rounded-lg
                       border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-bg_secondary_dark"
            >
              {storedTexts.map(([labelKey, text]) => (
                <div key={labelKey} className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-gray-700 dark:text-gray-300">
                    {t(labelKey)}
                  </span>
                  <p className="font-mono text-xs whitespace-pre-wrap break-words">{text}</p>
                </div>
              ))}
              <p className="text-xs text-gray-600 dark:text-gray-300">
                {t("radiology.feedback.data_also", { model: reportCase.model })}
              </p>
            </div>
          )}
        </div>

        <label className="flex items-start gap-2 text-xs cursor-pointer">
          <input
            type="checkbox"
            checked={consent}
            onChange={(event) => setConsent(event.target.checked)}
            className="mt-0.5 accent-tertiary"
          />
          <span>{t("radiology.feedback.consent")}</span>
        </label>

        {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

        <div className="flex flex-wrap items-center gap-3 w-full">
          {feedback && (
            <button
              type="button"
              onClick={withdraw}
              disabled={busy}
              className="text-xs text-red-600 dark:text-red-400 cursor-pointer
                       disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {t("radiology.feedback.withdraw")}
            </button>
          )}
          <div className="flex gap-3 ml-auto">
            <button
              type="button"
              className="cursor-pointer p-3 border dark:border-border_dark rounded-2xl
                       text-black dark:text-white bg-gray-100 dark:bg-gray-800
                       hover:bg-gray-200 dark:hover:bg-gray-700 min-w-[100px] select-none
                       disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={onClose}
              disabled={busy}
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="cursor-pointer p-3 bg-tertiary text-white rounded-2xl
                       hover:bg-tertiary/90 min-w-[100px] select-none shadow-lg dark:shadow-dark
                       disabled:opacity-40 disabled:cursor-not-allowed"
              disabled={!consent || busy}
              onClick={send}
            >
              {sending
                ? t("radiology.feedback.sending")
                : t(feedback ? "radiology.feedback.send_again" : "radiology.feedback.send")}
            </button>
          </div>
        </div>
      </div>
    </BaseModal>
  );
}
