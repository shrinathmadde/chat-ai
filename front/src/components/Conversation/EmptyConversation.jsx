import { useTranslation } from "react-i18next";
import Logo from "../../assets/logos/chat_ai.svg";

export default function EmptyConversation() {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col items-center justify-center w-full p-4 select-none">
      <img
        className="max-w-[160px] sm:max-w-[200px] md:max-w-[240px] w-full object-contain filter opacity-80 grayscale drop-shadow-lg"
        src={Logo}
        alt="Chat AI Logo"
      />
      <p className="mt-3 text-lg sm:text-xl md:text-2xl font-semibold uppercase tracking-widest text-gray-500 dark:text-gray-400">
        {t("branding.name_suffix")}
      </p>
    </div>
  );
}
