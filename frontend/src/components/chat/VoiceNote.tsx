import type { Attachment } from "@/lib/agent";
import { Pause, Play } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { fileUrl } from "./files";
import { clock } from "./format";

/**
 * A fixed bar pattern per clip. Real amplitudes would mean decoding the whole file in
 * the browser; a stable pseudo-random figure reads the same way and costs nothing.
 */
export function bars(id: string, count = 34) {
  let seed = 0;
  for (let i = 0; i < id.length; i++)
    seed = (seed * 31 + id.charCodeAt(i)) >>> 0;
  return Array.from({ length: count }, () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return 0.25 + ((seed >>> 16) % 1000) / 1000 / 1.35;
  });
}

/** Play/scrub a voice note in place, with its transcript underneath. */
export function VoiceNote({
  attachment,
  sessionId,
  isUser,
}: {
  attachment: Attachment;
  sessionId: string;
  isUser: boolean;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(0);
  const [total, setTotal] = useState(0);
  const shape = useMemo(() => bars(attachment.id), [attachment.id]);
  const progress = total > 0 ? at / total : 0;

  const toggle = () => {
    const el = audio.current;
    if (!el) return;
    if (el.paused) void el.play();
    else el.pause();
  };

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = audio.current;
    if (!el || !total) return;
    const box = e.currentTarget.getBoundingClientRect();
    el.currentTime = ((e.clientX - box.left) / box.width) * total;
  };

  return (
    <div
      className={`w-fit max-w-full rounded-[14px] px-3 py-2.5 ${isUser ? "bg-white/10" : "bg-field"}`}
    >
      <div className="flex items-center gap-3">
        <button
          onClick={toggle}
          aria-label={
            playing ? `Pause ${attachment.name}` : `Play ${attachment.name}`
          }
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
            isUser ? "bg-white/20" : "bg-ink text-on-primary"
          }`}
        >
          {playing ? (
            <Pause size={14} strokeWidth={2} fill="currentColor" />
          ) : (
            <Play
              size={14}
              strokeWidth={2}
              fill="currentColor"
              className="ml-0.5"
            />
          )}
        </button>

        <div
          onClick={seek}
          // Fixed width, not flex-1: the card is w-fit, so a basis-0 track would
          // contribute nothing to the intrinsic width and collapse to no bars.
          className="flex h-9 w-48 max-w-full shrink-0 cursor-pointer items-center gap-px"
        >
          {shape.map((h, i) => (
            <span
              key={i}
              className="flex-1 rounded-full"
              style={{
                height: `${Math.round(h * 26)}px`,
                backgroundColor: "currentColor",
                opacity: i / shape.length <= progress ? 0.9 : 0.28,
              }}
            />
          ))}
        </div>

        <span
          className={`tnum shrink-0 text-xs leading-[1.33] ${isUser ? "opacity-70" : "text-faint"}`}
        >
          {clock(playing || at > 0 ? total - at : total)}
        </span>
      </div>

      {attachment.preview && (
        <p
          className={`mt-2 text-[13px] leading-[1.4] ${isUser ? "opacity-70" : "text-muted"}`}
        >
          {attachment.preview}
        </p>
      )}

      <audio
        ref={audio}
        src={fileUrl(sessionId, attachment.id)}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setAt(0);
        }}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          setTotal(Number.isFinite(d) ? d : 0);
        }}
        onTimeUpdate={(e) => setAt(e.currentTarget.currentTime)}
      />
    </div>
  );
}
