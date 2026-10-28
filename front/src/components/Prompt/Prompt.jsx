import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import AbortButton from "./AbortButton";
import SendButton from "./SendButton";
import MicButton from "./MicButton";
import DictationButton from "../Others/DictationButton";
import AttachmentsContainer from "./AttachmentsContainer";
import SettingsButton from "../Header/SettingsButton";
import WarningExternalModel from "../Header/WarningExternalModel";
import ModelButton from "./ModelButton";
import ToolsButton from "./ToolsButton";
import AttachButton from "./AttachButton";
import AttachMediaButton from "./AttachMediaButton";
import PromptTextArea from "./PromptTextArea";
import ReportInputs from "./ReportInputs";

import { useSendMessage } from "../../hooks/useSendMessage";
import { useDebounce } from "../../hooks/useDebounce";
import { useToast } from "../../hooks/useToast";
import { insertTranscript } from "../../hooks/useDictation";
import { getDictationTarget, useDictationTarget } from "../../hooks/useDictationTarget";
import { formatInputs, missingKinds } from "../../utils/radiologyInputs";
import UndoButton from "../Conversation/UndoButton";

const radiologyModule = import.meta.env.VITE_MODULE_RADIOLOGY === "true";

export default function Prompt({
  localState,
  setLocalState,
  userData,
  modelsData,
}) {
  const { t } = useTranslation();
  const { notifyError } = useToast();
  const sendMessage = useSendMessage();
  const [shouldSend, setShouldSend] = useState(false);
  const [ignoreChanges, setIgnoreChanges] = useState(false);
  const lastMessage = localState.messages[localState.messages.length - 1];
  if (lastMessage?.content == undefined){
    // return to a valid conversation
    localState.messages = [{"content" : [{"text" : ""}]}];
  }
  const [prompt, setPrompt] = useState(lastMessage?.content[0]?.text || "");

  //const prompt = localState.messages[localState.messages.length - 1].content[0]?.text || "";
  const attachments = lastMessage.content.slice(1);

  // Radiology inputs live in memory only, per conversation. <Prompt> is not
  // remounted when the conversation changes, so keying by id keeps one
  // patient's reports from being sent in another chat.
  const [reportDrafts, setReportDrafts] = useState({});
  const conversationId = localState.id;
  const reportInputs = reportDrafts[conversationId] || [];
  const setReportInputs = (update) =>
    setReportDrafts((prev) => ({
      ...prev,
      [conversationId]: update(prev[conversationId] || []),
    }));
  const hasReportInputs = radiologyModule && reportInputs.length > 0;

  // Update partial local state while preserving other values
  const savePrompt = (nextPrompt = prompt, { clearChoices = false, meta } = {}) => {
    setIgnoreChanges(true);
    setLocalState((prev) => {
      const messages = [...prev.messages]; // shallow copy
      messages[messages.length - 1] = {
        role: "user",
        content: [ { // Replace first content item
            type: "text",
            text: nextPrompt
          }, // Keep other content items
          ...prev.messages[messages.length - 1].content.slice(1)
        ],
        ...(meta ? { meta } : {}),
      };
      return {
        ...prev,
        messages,
        ...(clearChoices ? { choices: [] } : {}),
      };
    });
  };

  // Effect, watch for changes to prompt in localState
  useEffect(() => {
    if (shouldSend) {
      sendMessage({localState, setLocalState});
      setShouldSend(false);
      setIgnoreChanges(false);
      setPrompt("");
    } else if (ignoreChanges) {
      setIgnoreChanges(false); // Ignored once
    } else {
      setPrompt(
        lastMessage?.content[0]?.text || ""
      );
    }
  }, [localState.messages]);

  // Handle changes to the prompt
  const debouncedSave = useDebounce(savePrompt, 300);
  const handleChange = (e) => {
    setPrompt(e.target.value);
    debouncedSave();
  };

  // The mic types into the text box the cursor was in last: this one or a
  // report (useDictationTarget). The target is fixed when recording starts
  // and outlined while it records and transcribes.
  const promptRef = useRef(null);
  const [dictating, setDictating] = useState(false);
  const dictationTarget = useRef(null);
  const handleDictating = (busy) => {
    setDictating(busy);
    if (busy && !dictationTarget.current) {
      dictationTarget.current = getDictationTarget();
      dictationTarget.current?.element()?.setAttribute("data-dictating", "");
    } else if (!busy) {
      dictationTarget.current?.element()?.removeAttribute("data-dictating");
      dictationTarget.current = null;
    }
  };
  // Dictated text goes where the cursor is, as if typed
  const insertDictation = (transcript) => {
    const textarea = promptRef.current;
    if (!textarea) return;
    const { text, cursor } = insertTranscript(
      textarea.value, textarea.selectionStart, textarea.selectionEnd, transcript
    );
    setPrompt(text);
    debouncedSave();
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(cursor, cursor);
    });
  };
  const handlePromptFocus = useDictationTarget(promptRef, insertDictation, { isDefault: true });

  // Handle form submission with prompt and files
  const handleSend = async (event, nextPrompt) => {
      event.preventDefault();
      // The text still being dictated would miss this message
      if (dictating) return;
      const promptToSend = typeof nextPrompt === "string" ? nextPrompt : prompt;
      if (promptToSend?.trim() === "" && attachments.length === 0 && !hasReportInputs) return;
      if (hasReportInputs) {
        const missing = missingKinds(reportInputs);
        if (missing.length > 0) {
          notifyError(t("radiology.missing_inputs", {
            inputs: missing.map((kind) => t(`radiology.${kind}`)).join(", "),
          }));
          return;
        }
        // The pipeline can't use attachments, so they may not silently go
        // missing; typed text goes along as instructions for the model
        if (attachments.length > 0) {
          notifyError(t("radiology.attachments_with_inputs"));
          return;
        }
      }
      debouncedSave.cancel();
      if (hasReportInputs) {
        // The inputs travel in meta; the text is their readable form
        const instructions = (promptToSend ?? "").trim();
        savePrompt(formatInputs(reportInputs, instructions), {
          clearChoices: true,
          meta: {
            radiology: { inputs: reportInputs, ...(instructions ? { instructions } : {}) },
          },
        });
        setReportInputs(() => []);
      } else {
        savePrompt(promptToSend, { clearChoices: true });
      }
      setShouldSend(true);
  };
  
  return (
    <div className="prompt-area overflow-x-hidden w-full flex flex-shrink-0 flex-col 
    bg-white dark:bg-bg_secondary_dark dark:text-white text-black mobile:h-fit justify-center 
    sm:overflow-y-auto rounded-2xl shadow-bottom dark:shadow-darkBottom
    md:max-w-[85vw] xl:max-w-[1300px] transition-[max-width] duration-300 ease-in-out motion-reduce:transition-none mx-auto">
        {/* Attachments Container */}
        <AttachmentsContainer
          localState={localState}
          setLocalState={setLocalState}
        />
        {/* Radiology inputs: previous reports, dictation, assessment */}
        {radiologyModule && (
          <ReportInputs inputs={reportInputs} setInputs={setReportInputs} />
        )}
        <div className={`flex flex-col gap-4 w-full relative select-none rounded-2xl shadow-lg dark:text-white text-black bg-white dark:bg-bg_secondary_dark`} >
        {/* Prompt Text Area */}
        <PromptTextArea
          localState={localState}
          setLocalState={setLocalState}
          handleSend={handleSend}
          handleChange={handleChange}
          prompt={prompt}
          hasReportInputs={hasReportInputs}
          inputRef={promptRef}
          onFocus={handlePromptFocus}
        />

        {/* Buttons Section */}
        <div className="px-3 py-2 w-full h-fit grid grid-cols-[1fr_auto_1fr] items-center bg-white dark:bg-bg_secondary_dark rounded-b-2xl relative">
          {/* Buttons on the left */}
          <div className="flex gap-4 items-center justify-start">
            {/* Attach Button */}
            <AttachButton
              localState={localState}
              setLocalState={setLocalState}
            />
               {/* Mic Button. With the radiology module it dictates into the
                   prompt box or a report instead of attaching audio, which the
                   report pipeline can't use. Keyed by conversation: switching
                   chats drops a running recording, so it never lands in
                   another patient's chat. */}
            {radiologyModule ? (
              <DictationButton
                key={conversationId}
                onText={(transcript) => dictationTarget.current?.insert(transcript)}
                onBusyChange={handleDictating}
              />
            ) : (
              <MicButton
                localState={localState}
                setLocalState={setLocalState}
              />
            )}

          </div>
          {/* Buttons in the center */}
          <div className="flex gap-4 items-center justify-center">
            
            {/* Tools Button */}
            <ToolsButton
              localState={localState}
              setLocalState={setLocalState}
            />
            {/* Settings Button */}
            <SettingsButton
              localState={localState}
              setLocalState={setLocalState}
              userData={userData}
              modelsData={modelsData}
            />
            {/* Model Selector — the header keeps its own on narrow screens.
                It shrinks first, so Abort/Send never lose their place. */}
            <div className="hidden md:flex min-w-0">
              <ModelButton
                localState={localState}
                setLocalState={setLocalState}
                modelsData={modelsData}
              />
            </div>
            {/* Data safety indicator */}
            <div className="hidden md:flex">
              <WarningExternalModel
                localState={localState}
                userData={userData}
                portalPanel
                compact
              />
            </div>
          </div>
          {/* Buttons on the right */}
          <div className="flex gap-4 items-center justify-end min-w-0">
            {/* Abort button (when loading) */}
            <AbortButton
              localState={localState}
              setLocalState={setLocalState}
            />
            {/* If not loading, show send button */}
            <SendButton
              localState={localState}
              setLocalState={setLocalState}
              handleSend={handleSend}
              prompt={prompt}
              hasReportInputs={hasReportInputs}
            />
          </div>
        </div>
      </div>
      </div>
  );
}
