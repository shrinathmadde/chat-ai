// hooks/useTabTitle.js
import { useEffect } from "react";
import { useSelector } from "react-redux";
import { useConversationList } from "../db";
import { selectLastConversation } from "../Redux/reducers/lastConversationSlice";

// Also the title in index.html, shown until this hook runs.
const APP_NAME = "Chat AI for Radiologists";

export const useTabTitle = () => {
  const currentConversationId = useSelector(selectLastConversation);
  const conversations = useConversationList();

  useEffect(() => {
      const currentConversation = conversations?.find(
        (conv) => conv.id === currentConversationId
      );

      if (currentConversation) {
        const title = currentConversation.title || "Untitled Chat";
        // "Untitled Conversation" is the pre-rename default, still stored on
        // chats created before it changed.
        const untitled =
          title === "Untitled Chat" || title === "Untitled Conversation";
        document.title = untitled ? APP_NAME : title + " - " + APP_NAME;
      } else {
        document.title = APP_NAME;
      }
    }, [currentConversationId, conversations]
  );
};

// Component version
export const TabTitleManager = () => {
  useTabTitle();
  return null;
};
