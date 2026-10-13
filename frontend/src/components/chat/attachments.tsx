import type { Attachment } from "@/lib/agent";
import {
  Download,
  FileSpreadsheet,
  FileText,
  FileType2,
  Mic,
  X,
} from "lucide-react";
import { VoiceNote } from "./VoiceNote";
import { FADE, fileUrl, isAudio, thumbUrl } from "./files";

/** A thumbnail; the route handler behind `src` attaches the Clerk session itself. */
export function Thumb({ src }: { src: string }) {
  if (!src) return null;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" className="w-full object-cover object-top" />;
}

/** Attachments queued in the composer: images as thumbnails, files as chips. */
export function AttachmentStrip({
  attachments,
  sessionId,
  onRemove,
}: {
  attachments: Attachment[];
  sessionId: string;
  onRemove?: (id: string) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {attachments.map((a) =>
        a.kind === "image" ? (
          <span key={a.id} className="relative">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={fileUrl(sessionId, a.id)}
              alt={a.name}
              className="border-hairline-soft h-16 w-16 rounded-xl border object-cover"
            />
            {onRemove && (
              <button
                onClick={() => onRemove(a.id)}
                aria-label={`Remove ${a.name}`}
                className="bg-ink text-on-primary absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full"
              >
                <X size={11} strokeWidth={2.5} />
              </button>
            )}
          </span>
        ) : (
          <span
            key={a.id}
            className="bg-field text-ink flex items-center gap-2 rounded-full py-1.5 pr-2 pl-3 text-xs leading-[1.33]"
          >
            {isAudio(a) ? (
              <Mic size={13} strokeWidth={1.75} className="shrink-0" />
            ) : a.kind === "pdf" ? (
              <FileType2 size={13} strokeWidth={1.75} className="shrink-0" />
            ) : a.kind === "sheet" ? (
              <FileSpreadsheet
                size={13}
                strokeWidth={1.75}
                className="shrink-0"
              />
            ) : (
              <FileText size={13} strokeWidth={1.75} className="shrink-0" />
            )}
            <span className="max-w-[200px] truncate">
              {isAudio(a) ? "Voice note" : a.name}
            </span>
            {onRemove && (
              <button
                onClick={() => onRemove(a.id)}
                aria-label={`Remove ${a.name}`}
                className="text-muted hover:text-ink flex h-5 w-5 items-center justify-center rounded-full"
              >
                <X size={12} strokeWidth={2} />
              </button>
            )}
          </span>
        ),
      )}
    </div>
  );
}

/** Non-image attachments on a sent message: one card per file, led by a faded preview. */
export function MessageDocs({
  docs,
  isUser,
  sessionId,
}: {
  docs: Attachment[];
  isUser: boolean;
  sessionId: string;
}) {
  if (docs.length === 0) return null;
  return (
    <div className="space-y-1.5">
      {docs.map((a) =>
        isAudio(a) ? (
          <VoiceNote
            key={a.id}
            attachment={a}
            sessionId={sessionId}
            isUser={isUser}
          />
        ) : (
          <div
            key={a.id}
            className={`w-[268px] max-w-full overflow-hidden rounded-[14px] ${
              isUser ? "bg-white/10" : "bg-field"
            }`}
          >
            {a.thumb ? (
              // A PDF shows its own first page. The image is wider than it is tall
              // here on purpose: the card is a glimpse of the page, not a reader.
              <span
                className="block h-[124px] overflow-hidden"
                style={{ maskImage: FADE, WebkitMaskImage: FADE }}
              >
                <Thumb src={thumbUrl(sessionId, a.id)} />
              </span>
            ) : (
              a.preview && (
                <span
                  className={`block max-h-[7.8em] overflow-hidden px-3 pt-3 font-mono text-[11.5px] leading-[1.3] whitespace-pre-wrap ${
                    isUser ? "opacity-55" : "text-muted"
                  }`}
                  style={{
                    // The preview is a sample, not the file: fading it out says so
                    // without a truncation mark that could be read as content.
                    maskImage: FADE,
                    WebkitMaskImage: FADE,
                  }}
                >
                  {a.preview}
                </span>
              )
            )}
            <span
              className={`block truncate px-3 pb-2.5 text-[13px] leading-[1.35] ${
                a.thumb || a.preview ? "pt-1.5" : "pt-2.5"
              }`}
            >
              {a.name}
            </span>
          </div>
        ),
      )}
    </div>
  );
}

/**
 * Images on a sent message, laid out the way a messaging app does it: flush to the
 * bubble edge, one large frame for a single image and a square grid beyond that.
 */
export function MessageMedia({
  images,
  sessionId,
}: {
  images: Attachment[];
  sessionId: string;
}) {
  if (images.length === 0) return null;
  const single = images.length === 1;
  return (
    <div className={single ? "" : "grid grid-cols-2 gap-1"}>
      {images.map((a) => (
        <span key={a.id} className="group relative block">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={fileUrl(sessionId, a.id)}
            alt={a.name}
            className={`block w-full rounded-2xl bg-black/6 ${
              single
                ? "max-h-[360px] object-contain"
                : "aspect-square object-cover"
            }`}
          />
        </span>
      ))}
    </div>
  );
}

/** Pull an attachment down. Same-origin, so the browser saves it under its own name. */
export function DownloadLink({
  sessionId,
  attachment,
  className = "",
}: {
  sessionId: string;
  attachment: Attachment;
  className?: string;
}) {
  return (
    <a
      href={fileUrl(sessionId, attachment.id)}
      download={attachment.name}
      title={`Download ${attachment.name}`}
      aria-label={`Download ${attachment.name}`}
      className={`flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 ${className}`}
    >
      <Download size={13} strokeWidth={1.75} />
    </a>
  );
}
