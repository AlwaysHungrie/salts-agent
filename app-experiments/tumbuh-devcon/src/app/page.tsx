"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/** Shrink the photo so the upload stays small. */
async function shrink(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((done) => canvas.toBlob((b) => done(b!), "image/jpeg", 0.85));
}

export default function Page() {
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [live, setLive] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const help = useRef<HTMLDialogElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const preview = useMemo(() => (photo ? URL.createObjectURL(photo) : ""), [photo]);

  // Attach the stream once the video element is on screen.
  useEffect(() => {
    if (live && video.current && stream.current) {
      video.current.srcObject = stream.current;
      void video.current.play();
    }
  }, [live]);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ message: string; amount?: string; txUrl?: string } | null>(null);
  const done = useRef<HTMLDialogElement>(null);
  const show = (r: { message: string; amount?: string; txUrl?: string }) => {
    setResult(r);
    done.current?.showModal();
  };

  async function openCamera() {
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
      setLive(true);
    } catch {
      picker.current?.click();
    }
  }

  async function snap() {
    const v = video.current!;
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext("2d")!.drawImage(v, 0, 0);
    stream.current?.getTracks().forEach((t) => t.stop());
    setLive(false);
    setPhoto(await new Promise<Blob>((done) => canvas.toBlob((b) => done(b!), "image/jpeg", 0.9)));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!photo) return;
    setBusy(true);
    try {
      const body = new FormData();
      body.set("photo", await shrink(photo), "photo.jpg");
      body.set("email", email);
      const res = await fetch("/api/submit", { method: "POST", body });
      show(await res.json());
      if (res.ok) setPhoto(null);
    } catch {
      show({ message: "Something went wrong. Try again." });
    }
    setBusy(false);
  }

  return (
    <form onSubmit={submit}>
      <h1>I&apos;m buying water</h1>
      <button type="button" className="outline" onClick={() => help.current?.showModal()}>
        How it works
      </button>
      <dialog ref={help}>
        <ol>
          <li>Pour a little water into the bottle.</li>
          <li>Take a picture of the bottle.</li>
          <li>Enter your email and send. Your agent gets paid.</li>
        </ol>
        <button type="button" onClick={() => help.current?.close()}>Close</button>
      </dialog>
      <div className="preview">
        <video ref={video} playsInline muted style={{ display: live ? "block" : "none" }} />
        {!live && photo && <img src={preview} alt="Your picture" />}
        {!live && !photo && <span>Preview</span>}
      </div>
      {live ? (
        <button type="button" onClick={snap}>Capture</button>
      ) : (
        <button type="button" className="outline" onClick={openCamera}>
          {photo ? "Retake" : "Take picture"}
        </button>
      )}
      <input
        ref={picker}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
      />
      <input
        type="email"
        required
        placeholder="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <button disabled={busy || !photo || live}>{busy ? "..." : "Send"}</button>
      <dialog ref={done}>
        {result?.txUrl ? (
          <>
            <h2>Thanks for the water</h2>
            <p>
              I paid your agent&apos;s wallet directly. You can access it at{" "}
              <a className="blue" href="https://app.salts.dev" target="_blank" rel="noreferrer">app.salts.dev</a>
            </p>
            <p>
              {result.amount}{" "}
              (<a href={result.txUrl} target="_blank" rel="noreferrer">txn</a>)
            </p>
          </>
        ) : (
          <p>{result?.message}</p>
        )}
        <button type="button" onClick={() => done.current?.close()}>Close</button>
      </dialog>
    </form>
  );
}
