import { Download, FileUp, Paperclip, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useAddAttachment, useAttachments, useDeleteAttachment } from "@/db/queries";
import { MAX_PER_MOVEMENT, readAttachment, type AttachmentRow } from "@/db/repo/attachments";
import { useErrorText } from "@/lib/use-error-text";

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function AttachmentsModal({ movementId, onClose }: { movementId: number; onClose: () => void }) {
  const { t } = useTranslation();
  const errText = useErrorText();
  const { data, isLoading } = useAttachments(movementId);
  const add = useAddAttachment();
  const del = useDeleteAttachment();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploadError, setUploadError] = useState<string>();

  const atLimit = (data?.length ?? 0) >= MAX_PER_MOVEMENT;

  const onPick = async (file: File) => {
    setUploadError(undefined);
    const bytes = new Uint8Array(await file.arrayBuffer());
    add.mutate(
      { movementId, file: { name: file.name, type: file.type, bytes } },
      { onError: (e) => setUploadError(errText(e)) },
    );
  };

  const open = async (att: AttachmentRow) => {
    const bytes = await readAttachment(att.stored_name);
    const blob = new Blob([bytes as BlobPart], { type: att.mime_type });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  return (
    <Modal open onClose={onClose} title={t("attachments", { defaultValue: "Attachments" })}>
      <div className="space-y-3">
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/heic,application/pdf,.png,.jpg,.jpeg,.webp,.heic,.pdf"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void onPick(f); e.target.value = ""; }}
        />
        <div className="flex items-center gap-2">
          <Button variant="outline" disabled={add.isPending || atLimit} onClick={() => fileRef.current?.click()}>
            <FileUp className="h-4 w-4" /> {add.isPending ? t("uploading", { defaultValue: "Uploading…" }) : t("add_file", { defaultValue: "Add file" })}
          </Button>
          <span className="text-xs text-muted">{t("attachments_hint", { defaultValue: "PNG, JPEG, WebP, HEIC, PDF · max 10 MB · up to 5 files" })}</span>
        </div>
        {atLimit && <p className="text-xs text-warning">{t("attachments_limit_reached", { defaultValue: "Maximum 5 attachments per movement" })}</p>}
        {uploadError && <p className="text-xs text-negative">{uploadError}</p>}

        {isLoading ? (
          <p className="text-sm text-muted">{t("loading", { defaultValue: "Loading…" })}</p>
        ) : (data?.length ?? 0) === 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted"><Paperclip className="h-4 w-4" /> {t("no_attachments", { defaultValue: "No files attached yet." })}</p>
        ) : (
          <ul className="divide-y divide-border">
            {data!.map((att) => (
              <li key={att.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{att.filename}</p>
                  <p className="text-xs text-muted">{humanSize(att.size_bytes)}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button onClick={() => void open(att)} aria-label={t("open", { defaultValue: "Open" })} className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-foreground">
                    <Download className="h-4 w-4" />
                  </button>
                  <button onClick={() => del.mutate(att)} disabled={del.isPending} aria-label={t("delete", { defaultValue: "Delete" })} className="rounded-md p-1.5 text-muted hover:bg-negative-soft hover:text-negative">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
