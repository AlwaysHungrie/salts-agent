import { useEffect, useRef, useState } from "react";
import { recordingSeconds, type ClientLimits } from "@/lib/agent";
import { startRecording, type Recorder } from "@/lib/recorder";

/**
 * A voice note being recorded. `recordedFor` is seconds into the take, or null when
 * the mic is idle. The take is capped by the deployment's audio ceiling: at the cap
 * it is stopped and kept rather than run into a clip the Worker would reject.
 */
export function useRecorder({
  limits,
  upload,
  setUploadError,
}: {
  limits: ClientLimits | null;
  upload: (files: File[]) => Promise<void>;
  setUploadError: (error: string | null) => void;
}) {
  const [recordedFor, setRecordedFor] = useState<number | null>(null);
  /** The live recorder is a handle, not rendered data. */
  const recorder = useRef<Recorder | null>(null);
  const recording = recordedFor !== null;

  const record = async () => {
    if (!limits) {
      setUploadError("Still loading this deployment's limits. Try again in a moment.");
      return;
    }
    setUploadError(null);
    try {
      recorder.current = await startRecording();
      setRecordedFor(0);
    } catch {
      setUploadError("No microphone. Check the browser's permission for this site.");
    }
  };

  const finishRecording = async (keep: boolean) => {
    const active = recorder.current;
    recorder.current = null;
    setRecordedFor(null);
    if (!active) return;
    if (!keep) {
      active.cancel();
      return;
    }
    try {
      const clip = await active.stop();
      if (clip) await upload([clip]);
    } catch {
      setUploadError("Could not encode the recording.");
    }
  };

  // Advance the counter once a second while a take is running, and never otherwise.
  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => {
      setRecordedFor((s) => (s ?? 0) + 1);
      if (limits && (recordedFor ?? 0) + 1 >= recordingSeconds(limits)) {
        void finishRecording(true);
      }
    }, 1000);
    return () => clearInterval(id);
    // finishRecording is stable enough for this: it only reads refs and setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, recordedFor]);

  return { recordedFor, recording, record, finishRecording };
}
