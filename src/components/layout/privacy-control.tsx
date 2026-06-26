/**
 * Topbar privacy-mode toggle. Beyond flipping the blur on/off it:
 *  - applies the configured hover-reveal behavior to <html> (the blur itself lives
 *    in globals.css, keyed on data-privacy / data-privacy-hover), and
 *  - when an unlock code is configured, gates *revealing* (turning privacy OFF)
 *    behind a small code prompt. Hiding never needs the code.
 */
import { Eye, EyeOff } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { cn } from "@/lib/cn";
import { usePreferences } from "@/db/queries";
import { usePrivacy } from "@/lib/privacy";

export function PrivacyControl() {
  const { t } = useTranslation();
  const privacy = usePrivacy();
  const { data: prefs } = usePreferences();
  const hoverReveal = (prefs?.privacy_hover_reveal ?? 1) === 1;
  const unlockCode = (prefs?.privacy_unlock_code ?? "").trim();

  const [askUnlock, setAskUnlock] = useState(false);
  const [code, setCode] = useState("");
  const [wrong, setWrong] = useState(false);

  // Mirror the hover-reveal preference onto <html> for the CSS rule.
  useEffect(() => {
    document.documentElement.dataset.privacyHover = hoverReveal ? "on" : "off";
  }, [hoverReveal]);

  const onToggle = () => {
    // Revealing (ON → OFF) requires the code when one is set; hiding is always free.
    if (privacy.on && unlockCode) {
      setCode("");
      setWrong(false);
      setAskUnlock(true);
      return;
    }
    privacy.toggle();
  };

  const tryUnlock = () => {
    if (code.trim() === unlockCode) {
      setAskUnlock(false);
      privacy.toggle();
    } else {
      setWrong(true);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        aria-label={t("privacy_mode", { defaultValue: "Privacy mode" })}
        aria-pressed={privacy.on}
        title={privacy.on ? t("privacy_mode_on", { defaultValue: "Privacy mode on — amounts hidden" }) : t("privacy_mode", { defaultValue: "Privacy mode" })}
        className={cn(
          "inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius-control)] transition-colors",
          privacy.on ? "bg-accent-soft text-primary" : "text-muted hover:bg-surface-2 hover:text-foreground",
        )}
      >
        {privacy.on ? <EyeOff className="h-[18px] w-[18px]" /> : <Eye className="h-[18px] w-[18px]" />}
      </button>

      <Modal open={askUnlock} onClose={() => setAskUnlock(false)} title={t("privacy_unlock_title", { defaultValue: "Unlock amounts" })} size="md">
        <div className="space-y-3">
          <p className="text-sm text-muted">{t("privacy_unlock_desc", { defaultValue: "Enter your code to show amounts again." })}</p>
          <Input
            type="password"
            inputMode="numeric"
            autoFocus
            value={code}
            onChange={(e) => { setCode(e.target.value); setWrong(false); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); tryUnlock(); } }}
          />
          {wrong && <p className="text-sm text-negative">{t("privacy_unlock_wrong", { defaultValue: "Wrong code." })}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => setAskUnlock(false)}>{t("cancel", { defaultValue: "Cancel" })}</Button>
            <Button type="button" onClick={tryUnlock} disabled={!code.trim()}>{t("unlock", { defaultValue: "Unlock" })}</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
