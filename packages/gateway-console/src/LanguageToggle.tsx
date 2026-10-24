import { useT } from "./i18n";

export function LanguageToggle() {
  const { t, lang, setLang } = useT();
  return (
    <div
      className="language-toggle"
      role="group"
      aria-label={t("common.language")}
    >
      <button
        type="button"
        className="btn small"
        aria-pressed={lang === "en"}
        onClick={() => setLang("en")}
      >
        EN
      </button>
      <span aria-hidden="true">/</span>
      <button
        type="button"
        className="btn small"
        aria-pressed={lang === "zh-CN"}
        onClick={() => setLang("zh-CN")}
      >
        中
      </button>
    </div>
  );
}
