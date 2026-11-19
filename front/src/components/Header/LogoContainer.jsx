import Logo from "../../assets/logos/chat_ai.svg";
import LogoSmall from "../../assets/logos/chat_ai_small.ico"
import { Link } from "react-router-dom";

export default function LogoContainer({ isMobile = false }) {
  // The logo leads to the start of this site, not to the general Chat AI.
  return !isMobile ? (
    <Link to={"/"}>
    <div className="flex items-center dark:border-gray-700">
      <img
        className="h-8 w-auto object-contain"
        src={Logo}
        alt="Chat AI Logo"
      />
    </div>
    </Link>
  ) : (
    <Link to={"/"}>
    <div className="flex-shrink-0">
      <img
        className="h-6 min-[400px]:h-7 min-[500px]:h-8 w-auto object-contain"
        src={LogoSmall}
        alt="Chat AI Logo"
      />
    </div>
    </Link>
  );
}