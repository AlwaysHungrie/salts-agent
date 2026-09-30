import { useEffect, useRef, useState } from "react";
import { imageTarget, type Attachment, type ClientLimits } from "@/lib/agent";
import { fitImage } from "@/lib/image";
import { pdfThumbnail } from "@/lib/pdf";
import { apiFetch } from "@/lib/identity";
import { isPdfFile, uploadFailure } from "./format";

/** A file on its way to the Worker, drawn from the browser's own copy until it lands. */
export type Ghost = { key: string; name: string; preview: string | null };

const filesUrl = (sessionId: string) =>
  `/api/sessions/${encodeURIComponent(sessionId)}/files`;

/**
 * The composer's attachments: held, uploading, and errors. Uploads run one at a time but
 * every pick shows at once; cancels that race a landed upload are cleaned up before send.
 */
export function useUploads(sessionId: string, limits: ClientLimits | null) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [ghosts, setGhosts] = useState<Ghost[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);

  /** Counter behind the ghost keys: unique per pick, without reading the clock. */
  const nextKey = useRef(0);
  /** Uploads dropped by the user before the Worker answered. */
  const cancelled = useRef(new Set<string>());
  /** The request behind each upload in flight, so cancelling can stop it. */
  const controllers = useRef(new Map<string, AbortController>());
  /**
   * Set only when a cancel raced a landed upload. Reconciling is a round trip, and
   * paying it on every send is what made the composer feel laggy.
   */
  const strayPossible = useRef(false);
  /** What the strip is holding, readable from async code that outlives a render. */
  const kept = useRef<Set<string>>(new Set());
  useEffect(() => {
    kept.current = new Set(attachments.map((a) => a.id));
  }, [attachments]);

  // An upload that was never sent stays pending in the Durable Object, so the chips
  // are restored when the session is reopened.
  useEffect(() => {
    void (async () => {
      const res = await apiFetch(filesUrl(sessionId));
      const payload = (await res.json().catch(() => null)) as {
        attachments?: Attachment[];
      } | null;
      setAttachments(payload?.attachments ?? []);
    })();
  }, [sessionId]);

  const remove = async (id: string) => {
    // The strip is what the notice was about, so changing it retires the notice.
    setUploadError(null);
    setAttachments((a) => a.filter((x) => x.id !== id));
    await apiFetch(`${filesUrl(sessionId)}/${id}`, { method: "DELETE" });
  };

  /**
   * Delete files the Worker holds that the strip does not (an aborted upload can still
   * land), so they do not ride along with the next message.
   */
  const reconcilePending = async (accepted: string[] = []) => {
    try {
      const res = await apiFetch(filesUrl(sessionId));
      const payload = (await res.json()) as { attachments?: Attachment[] };
      const keep = new Set([...kept.current, ...accepted]);
      const stray = (payload.attachments ?? []).filter((a) => !keep.has(a.id));
      strayPossible.current = false;
      await Promise.all(
        stray.map((a) =>
          apiFetch(`${filesUrl(sessionId)}/${a.id}`, { method: "DELETE" }),
        ),
      );
    } catch {
      // Best effort: a stray file is a wasted upload, not a broken session.
    }
  };

  /** Before a send: clear strays, but only if a cancel ever raced an upload. */
  const reconcileIfNeeded = async (sending: string[]) => {
    if (strayPossible.current) await reconcilePending(sending);
  };

  /** Take a pending upload off the strip; its row is deleted when it lands. */
  const cancelUpload = (key: string) => {
    setUploadError(null);
    cancelled.current.add(key);
    controllers.current.get(key)?.abort();
    setGhosts((g) => {
      const ghost = g.find((x) => x.key === key);
      if (ghost?.preview) URL.revokeObjectURL(ghost.preview);
      return g.filter((x) => x.key !== key);
    });
  };

  const upload = async (picked: File[]) => {
    if (!limits) {
      setUploadError("Still loading this deployment's limits. Try again in a moment.");
      return;
    }
    setUploading(true);
    setUploadError(null);

    // The Worker enforces this too; catching it here keeps the files that do fit.
    const perMessage = limits.max_files_per_message;
    const room = perMessage - (attachments.length + ghosts.length);
    if (picked.length > room) {
      setUploadError(
        `A message can carry ${perMessage} files. Send the rest with the next message.`,
      );
      picked = picked.slice(0, Math.max(room, 0));
      if (picked.length === 0) {
        setUploading(false);
        return;
      }
    }
    // An image previews from the browser's own copy, before the re-encode below.
    const queued = picked.map((original) => ({
      original,
      key: `${original.name}-${nextKey.current++}`,
      preview: original.type.startsWith("image/")
        ? URL.createObjectURL(original)
        : null,
    }));
    setGhosts((g) => [
      ...g,
      ...queued.map(({ key, original, preview }) => ({
        key,
        name: original.name,
        preview,
      })),
    ]);

    let aborted = false;
    // Ids accepted during this pick: `kept` only catches up on the next render, and
    // the reconcile below must not take a file it just stored for a cancelled one.
    const accepted: string[] = [];

    /** Nothing more is owed to a file once it is settled, kept or taken back. */
    const drop = (key: string, preview: string | null) => {
      cancelled.current.delete(key);
      controllers.current.delete(key);
      setGhosts((g) => g.filter((x) => x.key !== key));
      if (preview) URL.revokeObjectURL(preview);
    };

    for (const { original, key, preview } of queued) {
      // Taken back before its turn came up: never sent at all.
      if (cancelled.current.has(key)) {
        aborted = true;
        drop(key, preview);
        continue;
      }
      // A phone photo is routinely past the ceiling; shrink it. Anything that cannot
      // be shrunk is sent as it is, so the Worker's own message is what they see.
      const file = original.type.startsWith("image/")
        ? ((await fitImage(original, imageTarget(limits))) ?? original)
        : original;

      const form = new FormData();
      form.set("file", file);
      // The card shows the PDF's first page, and only the browser can draw it.
      if (isPdfFile(file)) {
        const thumb = await pdfThumbnail(file);
        if (thumb) form.set("thumbnail", thumb);
      }
      // Encoding can take long enough for the file to be taken back meanwhile.
      if (cancelled.current.has(key)) {
        aborted = true;
        drop(key, preview);
        continue;
      }

      // Cancelling aborts the request rather than waiting for the bytes to land.
      const controller = new AbortController();
      controllers.current.set(key, controller);

      type UploadPayload = { attachment?: Attachment; error?: string } | null;
      let res: Response;
      let payload: UploadPayload = null;
      try {
        res = await apiFetch(filesUrl(sessionId), {
          method: "POST",
          body: form,
          signal: controller.signal,
        });
        payload = (await res.json().catch(() => null)) as UploadPayload;
      } catch (err) {
        drop(key, preview);
        // An abort is the user's own doing and needs no telling.
        if (err instanceof DOMException && err.name === "AbortError") {
          aborted = true;
        } else {
          setUploadError(uploadFailure(file.name));
        }
        continue;
      }

      // Cancelled as it landed: the Worker stored it before the abort reached it.
      if (cancelled.current.has(key)) {
        aborted = true;
        drop(key, preview);
        if (payload?.attachment) void remove(payload.attachment.id);
        continue;
      }
      drop(key, preview);

      if (!res.ok || !payload?.attachment) {
        setUploadError(uploadFailure(file.name, payload?.error));
        continue;
      }
      accepted.push(payload.attachment.id);
      setAttachments((a) => [...a, payload.attachment!]);
    }
    setUploading(false);
    // Only a cancel can leave the Worker holding something the strip does not.
    if (aborted) {
      strayPossible.current = true;
      await reconcilePending(accepted);
    }
  };

  return {
    attachments,
    setAttachments,
    ghosts,
    uploading,
    uploadError,
    setUploadError,
    upload,
    remove,
    cancelUpload,
    reconcileIfNeeded,
  };
}
