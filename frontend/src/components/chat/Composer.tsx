import { useRef } from "react";
import { FileText, Mic, Paperclip, Send, Square, X } from "lucide-react";
import { recordingSeconds, type ClientLimits } from "@/lib/agent";
import { AttachmentStrip } from "./attachments";
import { acceptFor, clock } from "./format";
import type { useRecorder } from "./useRecorder";
import type { Ghost, useUploads } from "./useUploads";

/** Uploads still on their way: a pulsing thumbnail or chip, each with a cancel. */
function GhostStrip({
  ghosts,
  onCancel,
}: {
  ghosts: Ghost[];
  onCancel: (key: string) => void;
}) {
  return ghosts.map((g) =>
    g.preview ? (
      <span key={g.key} className="relative">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={g.preview}
          alt={g.name}
          className="border-hairline-soft h-16 w-16 animate-pulse rounded-xl border object-cover"
        />
        <button
          type="button"
          onClick={() => onCancel(g.key)}
          aria-label={`Cancel ${g.name}`}
          className="bg-ink text-on-primary absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full"
        >
          <X size={11} strokeWidth={2.5} />
        </button>
      </span>
    ) : (
      <span
        key={g.key}
        className="bg-field text-muted flex items-center gap-2 rounded-full py-1.5 pr-2 pl-3 text-xs leading-[1.33]"
      >
        {/* The label pulses, not the chip: the cancel button must stay solid. */}
        <FileText size={13} strokeWidth={1.75} className="animate-pulse" />
        <span className="max-w-[200px] animate-pulse truncate">{g.name}</span>
        <button
          type="button"
          onClick={() => onCancel(g.key)}
          aria-label={`Cancel ${g.name}`}
          className="text-muted hover:text-ink flex h-5 w-5 items-center justify-center rounded-full"
        >
          <X size={12} strokeWidth={2} />
        </button>
      </span>
    ),
  );
}

/** The recording bar that stands in for the text box while a take is running. */
function RecordingBar({
  recordedFor,
  limits,
  onDiscard,
}: {
  recordedFor: number;
  limits: ClientLimits | null;
  onDiscard: () => void;
}) {
  const left = limits ? recordingSeconds(limits) - recordedFor : Infinity;
  return (
    <div className="bg-field flex h-12 min-w-0 flex-1 items-center gap-3 rounded-2xl px-4">
      <span className="bg-ink h-2.5 w-2.5 shrink-0 animate-pulse rounded-full" />
      <span className="text-ink tnum text-base">{clock(recordedFor)}</span>
      <span className="text-faint flex-1 text-[13px]">
        {left <= 30 ? `Stopping in ${left}s` : "Recording…"}
      </span>
      <button
        type="button"
        onClick={onDiscard}
        className="text-muted hover:text-ink text-[13px] transition"
      >
        Discard
      </button>
    </div>
  );
}

const ICON_BUTTON =
  "border-hairline text-ink hover:bg-canvas-soft flex h-12 w-12 shrink-0 items-center justify-center rounded-full border transition disabled:opacity-40";

/** The composer: pending attachments, and the row that attaches, records and sends. */
export function Composer({
  sessionId,
  ready,
  limits,
  uploads,
  recorder,
  input,
  setInput,
  streaming,
  onSubmit,
  onStop,
}: {
  sessionId: string;
  ready: Set<string>;
  limits: ClientLimits | null;
  uploads: ReturnType<typeof useUploads>;
  recorder: ReturnType<typeof useRecorder>;
  input: string;
  setInput: (value: string) => void;
  streaming: boolean;
  onSubmit: (e: React.FormEvent) => void;
  onStop: () => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const { attachments, ghosts, uploading, uploadError } = uploads;
  const { recording, recordedFor } = recorder;
  const canAttach =
    ready.has("file_ingest") || ready.has("vision") || ready.has("audio_input");

  return (
    <div className="border-hairline-soft border-t px-4 py-4 md:px-8 md:py-6">
      {(attachments.length > 0 || ghosts.length > 0 || uploadError) && (
        <div className="mb-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <AttachmentStrip
              attachments={attachments}
              sessionId={sessionId}
              onRemove={(id) => void uploads.remove(id)}
            />
            <GhostStrip ghosts={ghosts} onCancel={uploads.cancelUpload} />
          </div>
          {uploadError && <p className="text-muted text-xs">{uploadError}</p>}
        </div>
      )}

      <form onSubmit={onSubmit} className="flex gap-2 md:gap-3">
        {canAttach && (
          <>
            <input
              ref={picker}
              type="file"
              multiple
              accept={acceptFor(ready)}
              hidden
              onChange={(e) => {
                if (e.target.files?.length)
                  void uploads.upload(Array.from(e.target.files));
                e.target.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => picker.current?.click()}
              disabled={uploading}
              title="Attach a file"
              aria-label="Attach a file"
              className={ICON_BUTTON}
            >
              <Paperclip size={18} strokeWidth={1.75} />
            </button>
          </>
        )}
        {ready.has("audio_input") && !recording && (
          <button
            type="button"
            onClick={() => void recorder.record()}
            disabled={uploading}
            title="Record a voice note"
            aria-label="Record a voice note"
            className={ICON_BUTTON}
          >
            <Mic size={18} strokeWidth={1.75} />
          </button>
        )}

        {recording ? (
          <RecordingBar
            recordedFor={recordedFor ?? 0}
            limits={limits}
            onDiscard={() => void recorder.finishRecording(false)}
          />
        ) : (
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={uploading ? "Uploading…" : "Message the agent…"}
            className="bg-field placeholder:text-faint text-ink focus:ring-ink h-12 min-w-0 flex-1 rounded-2xl px-4 text-base outline-none focus:ring-2"
          />
        )}
        {recording ? (
          <button
            type="button"
            onClick={() => void recorder.finishRecording(true)}
            title="Stop recording"
            aria-label="Stop recording"
            className="bg-ink text-on-primary flex h-12 w-12 shrink-0 items-center justify-center rounded-full transition hover:opacity-85"
          >
            <Square size={15} strokeWidth={2} fill="currentColor" />
          </button>
        ) : streaming ? (
          <button
            type="button"
            onClick={onStop}
            className="border-hairline text-ink hover:bg-canvas-soft h-12 shrink-0 rounded-full border px-6 text-base font-semibold transition"
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={
              uploading ||
              ghosts.length > 0 ||
              (!input.trim() && attachments.length === 0)
            }
            className="bg-ink text-on-primary h-12 min-w-12 shrink-0 rounded-full text-base font-semibold transition hover:opacity-85 disabled:opacity-30"
          >
            <span className="hidden md:block px-6">Send</span>
            <span className="md:hidden w-12 -ml-0.5 flex items-center justify-center">
              <Send size={18} />
            </span>
          </button>
        )}
      </form>
    </div>
  );
}
