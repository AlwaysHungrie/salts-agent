import { useEffect, useState } from "react";
import {
  ArrowLeft,
  Download,
  FileSpreadsheet,
  FileText,
  FileType2,
  Image as ImageIcon,
  Mic,
  X,
} from "lucide-react";
import type { Attachment } from "@/lib/agent";
import { formatBytes } from "@/lib/format";
import { fileUrl, isAudio } from "./chat/files";

function KindIcon({ a, size = 16 }: { a: Attachment; size?: number }) {
  const props = { size, strokeWidth: 1.75, className: "shrink-0" };
  if (a.kind === "image") return <ImageIcon {...props} />;
  if (isAudio(a)) return <Mic {...props} />;
  if (a.kind === "pdf") return <FileType2 {...props} />;
  if (a.kind === "sheet") return <FileSpreadsheet {...props} />;
  return <FileText {...props} />;
}

/** The most of a text file drawn at once; past it, the download has the rest. */
const TEXT_PREVIEW_CHARS = 200_000;

/**
 * A text file's words. Fetched and shown as text, never framed: an uploaded .html or
 * .svg would otherwise run on this origin.
 */
function TextPreview({ src }: { src: string }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    void (async () => {
      const res = await fetch(src).catch(() => null);
      const body = res?.ok ? await res.text().catch(() => null) : null;
      if (!live) return;
      if (body === null) setFailed(true);
      else setText(body);
    })();
    return () => {
      live = false;
    };
  }, [src]);
  if (failed) return <Notice>This file could not be loaded.</Notice>;
  if (text === null) return <Notice>Loading…</Notice>;
  const cut = text.length > TEXT_PREVIEW_CHARS;
  return (
    <div className="h-full overflow-auto p-5 md:p-6">
      <pre className="text-ink font-mono text-[13px] leading-[1.6] break-words whitespace-pre-wrap">
        {cut ? text.slice(0, TEXT_PREVIEW_CHARS) : text}
      </pre>
      {cut && (
        <p className="text-muted mt-4 text-xs">
          Showing the start of this file. Download it to see the rest.
        </p>
      )}
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-muted flex h-full items-center justify-center p-6 text-center text-sm">
      {children}
    </div>
  );
}

/** The selected file, drawn the way the browser can show it. */
function Preview({ sessionId, file }: { sessionId: string; file: Attachment }) {
  const src = fileUrl(sessionId, file.id);
  if (file.kind === "image") {
    return (
      <div className="flex h-full items-center justify-center overflow-auto bg-black/4 p-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={file.name}
          className="max-h-full max-w-full object-contain"
        />
      </div>
    );
  }
  if (file.kind === "pdf") {
    // The browser's own PDF viewer: pages, zoom and search come with it.
    return (
      <iframe src={src} title={file.name} className="h-full w-full border-0" />
    );
  }
  if (isAudio(file)) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6">
        <Mic size={28} strokeWidth={1.5} className="text-muted" />
        <audio controls src={src} className="w-full max-w-md" />
      </div>
    );
  }
  if (file.kind === "sheet") {
    return (
      <Notice>
        Excel workbooks cannot be previewed here. Download it to open it.
      </Notice>
    );
  }
  return <TextPreview key={file.id} src={src} />;
}

/**
 * Every file the chat holds — sent uploads and what the agent made, such as video
 * transcripts — as a file explorer: the list down the side, the chosen file previewed
 * beside it with its download. On a phone the list and the preview take turns.
 */
export function SessionFiles({
  sessionId,
  onClose,
}: {
  sessionId: string;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<Attachment[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/files?scope=chat`,
      ).catch(() => null);
      const payload = res?.ok
        ? ((await res.json().catch(() => null)) as {
            attachments?: Attachment[];
          } | null)
        : null;
      if (!live) return;
      if (!payload?.attachments) {
        setFailed(true);
        return;
      }
      setFiles(payload.attachments);
      // A wide screen has room for both, so it opens on the newest file.
      if (
        payload.attachments[0] &&
        window.matchMedia("(min-width: 768px)").matches
      ) {
        setSelectedId(payload.attachments[0].id);
      }
    })();
    return () => {
      live = false;
    };
  }, [sessionId]);

  // Escape closes, and the page behind stops scrolling while this is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  const selected = files?.find((f) => f.id === selectedId) ?? null;
  const closeButton = (
    <button
      onClick={onClose}
      aria-label="Close"
      className="text-muted hover:bg-canvas-soft hover:text-ink flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition"
    >
      <X size={16} strokeWidth={2} />
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 text-left font-normal md:p-8">
      <button
        onClick={onClose}
        aria-label="Close files"
        className="absolute inset-0 bg-black/40"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Files in this chat"
        className="border-hairline bg-canvas relative flex h-full max-h-[860px] w-full max-w-6xl overflow-hidden rounded-[20px] border shadow-xl"
      >
        {/* The list. On a phone it gives way to the preview once a file is chosen. */}
        <aside
          className={`border-hairline-soft w-full shrink-0 flex-col md:flex md:w-72 md:border-r ${
            selected ? "hidden" : "flex"
          }`}
        >
          <div className="flex items-center justify-between gap-2 px-5 pt-5 pb-3">
            <h2 className="text-ink text-lg font-[650] leading-[1.35]">
              Files{files ? ` (${files.length})` : ""}
            </h2>
            <span className="md:hidden">{closeButton}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {failed ? (
              <p className="text-muted px-3 py-2 text-sm">
                The files could not be loaded. Try again in a moment.
              </p>
            ) : files === null ? (
              <p className="text-muted px-3 py-2 text-sm">Loading…</p>
            ) : files.length === 0 ? (
              <p className="text-muted px-3 py-2 text-sm leading-[1.43]">
                No files yet. Files you send and files your agent makes, such as
                video transcripts, show up here.
              </p>
            ) : (
              <ul className="space-y-0.5">
                {files.map((a) => {
                  const active = a.id === selectedId;
                  return (
                    <li key={a.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(a.id)}
                        aria-current={active ? "true" : undefined}
                        className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm leading-[1.43] transition ${
                          active
                            ? "bg-field text-ink"
                            : "text-ink hover:bg-canvas-soft"
                        }`}
                      >
                        <span className="text-muted">
                          <KindIcon a={a} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{a.name}</span>
                          <span className="text-muted tnum block text-xs">
                            {formatBytes(a.bytes)}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </aside>

        {/* The preview. */}
        <section
          className={`min-w-0 flex-1 flex-col md:flex ${selected ? "flex" : "hidden"}`}
        >
          <div className="border-hairline-soft flex items-center gap-2 border-b px-3 py-3 md:px-5">
            {selected && (
              <button
                onClick={() => setSelectedId(null)}
                aria-label="Back to files"
                className="text-muted hover:bg-canvas-soft hover:text-ink flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition md:hidden"
              >
                <ArrowLeft size={16} strokeWidth={2} />
              </button>
            )}
            <div className="min-w-0 flex-1">
              <div className="text-ink truncate text-sm font-semibold leading-[1.43]">
                {selected?.name ?? "No file selected"}
              </div>
              {selected && (
                <div className="text-muted tnum text-xs">
                  {formatBytes(selected.bytes)}
                </div>
              )}
            </div>
            {selected && (
              <a
                href={fileUrl(sessionId, selected.id)}
                download={selected.name}
                className="border-hairline text-ink hover:bg-canvas-soft flex shrink-0 items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-medium transition"
              >
                <Download size={14} strokeWidth={1.75} />
                <span className="hidden sm:inline">Download</span>
              </a>
            )}
            {closeButton}
          </div>
          <div className="min-h-0 flex-1">
            {selected ? (
              <Preview
                key={selected.id}
                sessionId={sessionId}
                file={selected}
              />
            ) : (
              <Notice>Choose a file to preview it.</Notice>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
