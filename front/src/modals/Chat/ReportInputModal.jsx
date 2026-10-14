import { useLayoutEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Attachment, Close, Document, Microphone } from "@carbon/icons-react";
import BaseModal from "../BaseModal";
import Tooltip from "../../components/Others/Tooltip";
import { useDictation } from "../../hooks/useDictation";
import {
  ACCEPTED_FILES,
  MAX_FILE_SIZE_MB,
  readReportFile,
} from "../../utils/reportFiles";

// A space between dictated text and its neighbours, only where two words
// would otherwise run together.
const needsSpace = (left, right) =>
  left !== "" && right !== "" && !/\s$/.test(left) && !/^\s/.test(right);

const formatDuration = (seconds) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

// Large paste area for one radiology input (previous report, dictation or
// assessment). The text is passed on exactly as entered, dictated or read
// from an attached file (PDF, Word, text). An attached file only fills in its
// text: removing it takes that text out again, and only the text is kept.
export default function ReportInputModal({
  isOpen,
  onClose,
  kind,
  initialText = "",
  onConfirm,
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(initialText);
  const textareaRef = useRef(null);
  const cursorRef = useRef(initialText.length);

  // Dictated text goes where the cursor is, replacing any selection
  const insertAtCursor = (transcript) => {
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? text.length;
    const end = textarea?.selectionEnd ?? text.length;
    const before = text.slice(0, start);
    const after = text.slice(end);
    const inserted =
      (needsSpace(before, transcript) ? " " : "") +
      transcript +
      (needsSpace(transcript, after) ? " " : "");
    cursorRef.current = before.length + inserted.length;
    setText(before + inserted + after);
  };
  const dictation = useDictation(insertAtCursor);

  // Attached files: { id, name, text } of the text each one filled in
  const [files, setFiles] = useState([]);
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);
  // { text, isError } under the text box
  const [notice, setNotice] = useState(null);
  const fileInputRef = useRef(null);
  const nextFileId = useRef(0);
  const busy = dictation.status !== "idle" || reading;

  // File text goes where the cursor is, on lines of its own. Reads the text
  // box itself: several files are read one after another.
  const insertFileText = (fileText) => {
    const textarea = textareaRef.current;
    const current = textarea.value;
    const before = current.slice(0, textarea.selectionStart);
    const after = current.slice(textarea.selectionEnd);
    const inserted =
      (before !== "" && !before.endsWith("\n") ? "\n" : "") +
      fileText +
      (after !== "" && !after.startsWith("\n") ? "\n" : "");
    cursorRef.current = before.length + inserted.length;
    setText(before + inserted + after);
  };

  const attachFiles = async (selected) => {
    setNotice(null);
    setReading(true);
    const errors = [];
    for (const file of selected) {
      try {
        const fileText = await readReportFile(file);
        insertFileText(fileText);
        setFiles((prev) => [...prev, { id: nextFileId.current++, name: file.name, text: fileText }]);
      } catch (error) {
        errors.push(
          t(`radiology.file_error.${error.code || "failed"}`, {
            name: file.name,
            size: MAX_FILE_SIZE_MB,
          })
        );
      }
    }
    setReading(false);
    if (errors.length > 0) setNotice({ text: errors.join(" "), isError: true });
  };

  // Takes the file's text out again, with the line break added in front of or
  // behind it. Text the user has edited since is left alone.
  const removeFile = (file) => {
    setFiles((prev) => prev.filter((other) => other.id !== file.id));
    const at = text.indexOf(file.text);
    if (at === -1) {
      setNotice({ text: t("radiology.file_text_edited", { name: file.name }), isError: false });
      return;
    }
    let from = at;
    let to = at + file.text.length;
    if (text[to] === "\n" && (from === 0 || text[from - 1] === "\n")) to++;
    else if (to === text.length && text[from - 1] === "\n") from--;
    setNotice(null);
    setText(text.slice(0, from) + text.slice(to));
  };

  // Files can be dropped anywhere in the window's content, so a near miss
  // doesn't make the browser open the file instead; dragged text is left alone
  const hasFiles = (event) => event.dataTransfer.types.includes("Files");
  const dropHandlers = {
    onDragOver: (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      setDragging(true);
    },
    onDragLeave: (event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false);
    },
    onDrop: (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      setDragging(false);
      if (!busy) attachFiles([...event.dataTransfer.files]);
    },
  };

  const dictationLabel = {
    idle: t("radiology.dictate"),
    recording: t("radiology.dictate_stop"),
    transcribing: t("radiology.transcribing"),
  }[dictation.status];
  const isEmpty = text.trim() === "";

  // Place the cursor at the end on open, and behind newly dictated text
  useLayoutEffect(() => {
    if (cursorRef.current === null) return;
    textareaRef.current?.focus();
    textareaRef.current?.setSelectionRange(cursorRef.current, cursorRef.current);
    cursorRef.current = null;
  }, [text]);

  const handleConfirm = () => {
    if (isEmpty || busy) return;
    onConfirm(text);
    onClose();
  };

  return (
    <BaseModal
      isOpen={isOpen}
      onClose={onClose}
      titleKey={`radiology.modal_title.${kind}`}
      maxWidth="max-w-4xl"
      // Escape or a click outside must not throw away a running dictation
      isForced={busy}
    >
      <div className="flex flex-col gap-3" {...dropHandlers}>
        {files.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {files.map((file) => (
              <span
                key={file.id}
                className="flex items-center gap-1.5 max-w-xs pl-2.5 pr-1 py-1 rounded-lg text-xs
                         border border-blue-200 dark:border-blue-700/50
                         bg-blue-50 dark:bg-blue-900/20 text-gray-900 dark:text-white"
              >
                <Document size={16} className="flex-shrink-0 text-tertiary" />
                <span className="truncate">{file.name}</span>
                <button
                  type="button"
                  className="p-0.5 rounded-full cursor-pointer hover:bg-white/90 dark:hover:bg-black/70"
                  aria-label={t("radiology.remove_file", { name: file.name })}
                  title={t("radiology.remove_file", { name: file.name })}
                  onClick={() => removeFile(file)}
                  disabled={busy}
                >
                  <Close size={16} className="opacity-70 hover:opacity-100" />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              handleConfirm();
            }
          }}
          spellCheck={false}
          placeholder={t("radiology.paste_placeholder")}
          className={`w-full h-[60vh] p-3 text-sm font-sans resize-none border dark:border-border_dark rounded-lg
                   bg-white dark:bg-black text-black dark:text-white
                   focus:outline-none focus:ring-2 focus:ring-tertiary
                   ${dragging ? "ring-2 ring-tertiary border-dashed" : ""}`}
        />
        {notice && (
          <p
            className={`text-xs ${
              notice.isError
                ? "text-red-600 dark:text-red-400"
                : "text-amber-700 dark:text-amber-400"
            }`}
          >
            {notice.text}
          </p>
        )}
        {files.length > 0 && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            {t("radiology.file_hint")}
          </p>
        )}
        <p className="text-xs text-gray-500 dark:text-gray-400">
          <Trans i18nKey="radiology.verbatim_hint" />
        </p>
        <div className="flex flex-wrap items-center justify-between gap-3 w-full">
          <div className="flex items-center gap-2">
            <Tooltip text={dictationLabel}>
              <button
                type="button"
                aria-label={dictationLabel}
                className={`h-10 w-10 rounded-full flex items-center justify-center
                         cursor-pointer transition-colors disabled:cursor-wait ${
                           dictation.status === "recording"
                             ? "bg-red-500 hover:bg-red-600 animate-pulse"
                             : "bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700"
                         }`}
                onClick={
                  dictation.status === "recording"
                    ? dictation.stop
                    : dictation.start
                }
                disabled={dictation.status === "transcribing" || reading}
              >
                {dictation.status === "idle" && (
                  <Microphone size={20} className="text-tertiary" />
                )}
                {dictation.status === "recording" && (
                  <span className="w-3 h-3 bg-white rounded-sm" />
                )}
                {dictation.status === "transcribing" && (
                  <span className="w-4 h-4 border-2 border-tertiary border-t-transparent rounded-full animate-spin" />
                )}
              </button>
            </Tooltip>
            {dictation.status === "recording" && (
              <span className="text-sm tabular-nums text-gray-500 dark:text-gray-400">
                {formatDuration(dictation.seconds)}
              </span>
            )}
            <Tooltip text={t(reading ? "radiology.reading_file" : "radiology.attach_file")}>
              <button
                type="button"
                aria-label={t(reading ? "radiology.reading_file" : "radiology.attach_file")}
                className="h-10 w-10 rounded-full flex items-center justify-center cursor-pointer
                         transition-colors bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700
                         disabled:cursor-not-allowed disabled:opacity-60"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy}
              >
                {reading ? (
                  <span className="w-4 h-4 border-2 border-tertiary border-t-transparent rounded-full animate-spin" />
                ) : (
                  <Attachment size={20} className="text-tertiary" />
                )}
              </button>
            </Tooltip>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ACCEPTED_FILES}
              className="hidden"
              onChange={(event) => {
                // Copy before clearing, so the same file can be picked again
                const selected = [...event.target.files];
                event.target.value = "";
                attachFiles(selected);
              }}
            />
          </div>
          <div className="flex gap-3 ml-auto">
            <button
              className="cursor-pointer p-3 border dark:border-border_dark rounded-2xl
                       text-black dark:text-white bg-gray-100 dark:bg-gray-800
                       hover:bg-gray-200 dark:hover:bg-gray-700
                       min-w-[100px] select-none"
              onClick={onClose}
            >
              {t("common.cancel")}
            </button>
            <button
              className="cursor-pointer p-3 bg-tertiary text-white rounded-2xl
                       hover:bg-tertiary/90 min-w-[100px]
                       select-none shadow-lg dark:shadow-dark
                       disabled:opacity-40 disabled:cursor-not-allowed"
              disabled={isEmpty || busy}
              onClick={handleConfirm}
            >
              {t("common.ok")}
            </button>
          </div>
        </div>
      </div>
    </BaseModal>
  );
}
