import { useTranslation } from "react-i18next";
import { DomainError, type DomainErrorCode } from "@/db/errors";

const MESSAGES: Record<DomainErrorCode, string> = {
  cross_currency: "Both sources must share the same currency.",
  fund_not_mergeable: "Savings funds can't be merged.",
  fund_save_rejected: "You can't save from a savings fund.",
  not_a_fund: "That source isn't a savings fund.",
  active_goal_blocks_delete: "An active goal still uses this source.",
  has_portfolios: "This source has portfolios — move or delete them first.",
  currency_mismatch: "Currency doesn't match the source.",
  not_found: "Not found.",
  invalid_amount: "Amount must be greater than zero.",
  note_too_long: "Note is too long (max 1000 characters).",
  invalid_range: "The selected range is invalid.",
  is_transfer_leg: "This is part of a transfer — edit it from the transfer form.",
  not_a_transfer: "This movement isn't a transfer.",
  same_source: "Pick two different accounts.",
  is_savings_pair: "This is a savings deposit — edit it from the Savings page.",
  is_goal_allocation: "This is a goal allocation — manage it from the Goals page.",
  fund_transfer_not_allowed: "Transfers can't touch a savings fund — use Save/Withdraw instead.",
  fund_not_deletable: "Savings funds can't be deleted — they hold your saved money.",
  unknown_tag: "One of the tags no longer exists.",
  not_yet_due: "This item isn't due yet.",
  recurring_ended: "This recurring item has ended.",
  duplicate_budget: "An active budget for this tag and currency already exists.",
  invalid_currency: "Unknown currency code. Use a valid ISO 4217 code.",
  invalid_name: "Give it a name.",
  goal_not_active: "This goal isn't active.",
  alloc_from_own_source: "You can't allocate from the goal's own fund.",
  close_to_own_source: "Pick a different account to refund into — not the goal's own fund.",
  goal_cancelled: "This goal was cancelled.",
  use_close_or_delete: "Use Close (refund) or Delete to wind a goal down.",
  whim_already_purchased: "This item was already purchased.",
  not_pending: "Only pending items can do that.",
  not_dismissed: "Only dismissed items can be restored.",
  tag_name_required: "Give the tag a name.",
  duplicate_tag: "A tag with that name already exists.",
  invalid_color: "Color must be a hex code like #6366f1.",
  attachment_limit_reached: "Maximum 5 attachments per movement.",
  attachment_too_large: "File too large (max 10 MB).",
  attachment_empty: "The file is empty.",
  attachment_unsupported: "Unsupported file type. Allowed: PNG, JPEG, WebP, HEIC, PDF.",
  cannot_make_transfer_recurring: "Transfers can't be made recurring.",
  no_currency: "Set a base currency in Settings to make this recurring.",
  fund_currency_locked: "A savings fund's currency can't be changed — it is the fund for that currency.",
  active_goal_blocks_currency_change: "An active goal saves into this account in its current currency — close or delete it first.",
  linked_goal_currency_locked: "This whim has an active savings goal in its current currency — close or delete the goal first.",
};

/** Maps a thrown DomainError (or any error) to a localized, human message. */
export function useErrorText() {
  const { t } = useTranslation();
  return (err: unknown): string => {
    if (err instanceof DomainError) {
      return t(`err_${err.code}`, { defaultValue: MESSAGES[err.code] });
    }
    // tauri-plugin-sql rejects with a plain string, not an Error — so reading
    // `.message` alone would drop the real SQLite message and show the fallback.
    if (typeof err === "string" && err.trim()) return err;
    const msg = (err as { message?: unknown } | null)?.message;
    if (typeof msg === "string" && msg.trim()) return msg;
    return "Something went wrong.";
  };
}
