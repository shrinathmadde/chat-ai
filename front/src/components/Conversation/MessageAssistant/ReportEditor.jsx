import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Eye, EyeOff, RotateCcw } from "lucide-react";
import { useModal } from "../../../modals/ModalContext";
import { insertTranscript } from "../../../hooks/useDictation";
import { useDictationTarget } from "../../../hooks/useDictationTarget";
import { diffReport } from "../../../utils/reportDiff";

// The highlight layer lies behind a transparent textarea in the same grid
// cell; both must lay out the text identically, so they share these classes
const TEXT_LAYOUT =
  "col-start-1 row-start-1 p-3 font-mono text-sm whitespace-pre-wrap break-words";
const ADDED = "rounded-sm bg-green-200 dark:bg-green-800/70";
const REMOVED =
  "rounded-sm bg-red-100 text-red-700 line-through dark:bg-red-900/40 dark:text-red-300";

// Each piece of text alone in its own span: React then sets it as the span's
// content and keeps no loose text nodes of its own. Browser extensions
// (Grammarly, translators) merge or wrap loose text nodes, which breaks
// React's next update and blanks the whole page.
function Text({ text, className }) {
  return text ? <span className={className}>{text}</span> : null;
}

// Highlight the words of a change, not the spaces around it
function Marked({ text, className }) {
  const [, before, core, after] = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
  return (
    <>
      <Text text={before} />
      <Text text={core} className={className} />
      <Text text={after} />
    </>
  );
}

function Segments({ segments, showRemoved }) {
  return segments.map((segment, i) => (
    <Fragment key={i}>
      {segment.type === "same" && <Text text={segment.text} />}
      {segment.type === "added" && <Marked text={segment.text} className={ADDED} />}
      {/* Only in the read-only view, so the gap can't shift the highlights */}
      {segment.type === "removed" && showRemoved && (
        <Marked text={segment.text} className={`${REMOVED} mr-1`} />
      )}
    </Fragment>
  ));
}

// Follow-up report from the radiology pipeline, editable in place. Text that
// differs from the previous report is highlighted green; "Show removed text"
// switches to a read-only view that also shows, struck through, what was taken
// out. Edits are saved when the text box loses focus. A notice asks to check
// the assessment when the model wrote it: an unchanged course judgement
// carried over by mistake would show no highlight.
export default function ReportEditor({ text, previous, generated, assessmentGenerated, onSave }) {
  const { t } = useTranslation();
  const { confirmAction } = useModal();
  const [draft, setDraft] = useState(text);
  const [showRemoved, setShowRemoved] = useState(false);
  const editing = useRef(false);

  // Take over text saved elsewhere (restore, another tab), never while typing
  useEffect(() => {
    if (!editing.current) setDraft(text);
  }, [text]);

  const segments = useMemo(() => diffReport(previous, draft), [previous, draft]);
  const hasChanges = !!segments?.some((segment) => segment.type !== "same");
  // Reports generated before the editor existed don't keep the original
  const isEdited = typeof generated === "string" && draft !== generated;

  const save = () => {
    editing.current = false;
    if (draft !== text) onSave(draft);
  };

  // The mic under the prompt types here once the cursor was in this report
  // (useDictationTarget). Dictated text goes where the cursor was and is saved
  // at once: pressing the mic has already ended the edit. If the read-only
  // view was opened meanwhile, there is no cursor, so it goes at the end.
  const textareaRef = useRef(null);
  const insertDictation = (transcript) => {
    const textarea = textareaRef.current;
    const { text: next, cursor } = insertTranscript(
      draft,
      textarea?.selectionStart ?? draft.length,
      textarea?.selectionEnd ?? draft.length,
      transcript
    );
    setDraft(next);
    onSave(next);
    if (!textarea) return;
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(cursor, cursor);
    });
  };
  const handleDictationFocus = useDictationTarget(textareaRef, insertDictation);

  const restore = () =>
    confirmAction(
      {
        warningKey: "warn_restore_report",
        messageKey: "alert.restore_report_confirm",
        confirmKey: "alert.restore_report_yes",
        danger: true,
      },
      () => {
        setDraft(generated);
        onSave(generated);
      }
    );

  return (
    <div className="flex flex-col gap-1.5">
      {assessmentGenerated && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          {t("radiology.assessment_generated_hint")}
        </p>
      )}
      {/* Legend and actions */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-gray-600 dark:text-gray-300">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {segments && !hasChanges && <span>{t("radiology.no_changes")}</span>}
          {hasChanges && (
            <span className="flex items-center gap-1.5">
              <span className={`inline-block h-3 w-3 ${ADDED}`} />
              {t("radiology.changes_legend")}
            </span>
          )}
          {hasChanges && showRemoved && (
            <span className="flex items-center gap-1.5">
              <span className={`inline-block h-3 w-3 ${REMOVED}`} />
              {t("radiology.removed_legend")}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {isEdited && (
            <>
              <span className="italic text-gray-500 dark:text-gray-400">
                {t("radiology.edited")}
              </span>
              <button
                onClick={restore}
                className="flex items-center gap-1 text-tertiary cursor-pointer"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {t("radiology.restore")}
              </button>
            </>
          )}
          {hasChanges && (
            <button
              onClick={() => setShowRemoved((show) => !show)}
              className="flex items-center gap-1 text-tertiary cursor-pointer"
            >
              {showRemoved ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              {t(showRemoved ? "radiology.hide_removed" : "radiology.show_removed")}
            </button>
          )}
        </div>
      </div>

      <div
        translate="no"
        className="grid grid-cols-1 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-bg_secondary_dark focus-within:border-tertiary">
        {showRemoved && hasChanges ? (
          // Read-only: removed text is not part of the report
          <div className={TEXT_LAYOUT}>
            <Segments segments={segments} showRemoved />
          </div>
        ) : (
          <>
            <div
              aria-hidden
              className={`${TEXT_LAYOUT} text-transparent select-none pointer-events-none`}
            >
              {segments ? <Segments segments={segments} /> : <Text text={draft} />}
              {/* Lets a final line break take up a line, as in the textarea */}
              <Text text=" " />
            </div>
            {/* Report text is patient data: keep Grammarly out, it checks
                text on its own servers (and rewrites the page) */}
            <textarea
              ref={textareaRef}
              value={draft}
              rows={1}
              spellCheck={false}
              data-gramm="false"
              data-gramm_editor="false"
              data-enable-grammarly="false"
              aria-label={t("radiology.report")}
              onChange={(event) => setDraft(event.target.value)}
              onFocus={() => {
                editing.current = true;
                handleDictationFocus();
              }}
              onBlur={save}
              className={`${TEXT_LAYOUT} h-full w-full resize-none overflow-hidden bg-transparent outline-none
                       rounded-lg data-[dictating]:ring-2 data-[dictating]:ring-inset data-[dictating]:ring-red-400`}
            />
          </>
        )}
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        {t(showRemoved && hasChanges ? "radiology.review_hint" : "radiology.edit_hint")}
      </p>
    </div>
  );
}
