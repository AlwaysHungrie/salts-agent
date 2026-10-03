"use client";

import { useEffect, useRef, useState } from "react";
import { Badge } from "./Badge";
import { Markdown } from "./Markdown";
import { resumeProblem } from "@/lib/rules";

type Resume = { fileName: string; bytes: number; reply: string; createdAt: string };
type Listing = { resumes: Resume[]; updatableAt: string | null };

async function fetchResumes(base: string): Promise<Listing | null> {
  const res = await fetch(base, { cache: "no-store" }).catch(() => null);
  return res?.ok ? ((await res.json()) as Listing) : null;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const timeFormat = new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });

/** The user's badge, and the resumes pinned to it. */
export function ResumePanel({ userId, name }: { userId: string; name: string }) {
  const base = `/api/users/${encodeURIComponent(userId)}/resume`;
  const input = useRef<HTMLInputElement>(null);
  const details = useRef<HTMLDialogElement>(null);
  const [resumes, setResumes] = useState<Resume[] | null>(null);
  const [updatableAt, setUpdatableAt] = useState<string | null>(null);
  const [shown, setShown] = useState<Resume | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [over, setOver] = useState(false);

  function apply(listing: Listing | null) {
    setResumes(listing?.resumes ?? []);
    setUpdatableAt(listing?.updatableAt ?? null);
  }

  useEffect(() => {
    let live = true;
    void fetchResumes(base).then((listing) => {
      if (live) apply(listing);
    });
    return () => {
      live = false;
    };
  }, [base]);

  // Unlock the upload once the cooldown has passed, without a reload.
  useEffect(() => {
    if (!updatableAt) return;
    const timer = setTimeout(() => setUpdatableAt(null), Math.max(0, new Date(updatableAt).getTime() - Date.now()));
    return () => clearTimeout(timer);
  }, [updatableAt]);

  async function upload(file: File) {
    if (busy || updatableAt) return;
    const problem = resumeProblem(file);
    if (problem) return setError(problem);
    setBusy(file.name);
    setError("");
    const form = new FormData();
    form.append("file", file);
    try {
      const res = await fetch(base, { method: "POST", body: form });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) setError(body.error ?? "Your resume wasn’t added. Try again.");
      if (res.ok || res.status === 429) apply(await fetchResumes(base));
    } catch {
      setError("Your resume wasn’t added. Check your connection and try again.");
    } finally {
      setBusy("");
      if (input.current) input.current.value = "";
    }
  }

  function show(resume: Resume) {
    setShown(resume);
    details.current?.showModal();
  }

  const candidate = !!resumes?.length;
  const locked = !!updatableAt;

  return (
    <aside className="flex flex-col gap-6 lg:min-h-0 lg:overflow-y-auto lg:pb-2">
      <Badge strap="h-6" className="mx-auto w-full max-w-[340px]">
        <p className="text-sm text-ink-2">Hello, I&rsquo;m</p>
        <p className="mt-1 font-display text-3xl font-bold tracking-tight break-words text-violet">{name}</p>
        <p className="mt-4 text-sm text-ink-2">
          {resumes === null
            ? " "
            : candidate
              ? "Attendees will be able to find you here."
              : "Add your resume so teams can find you."}
        </p>
        {candidate && (
          <span className="stamp absolute top-4 right-4 rounded-md border-2 border-teal px-2 py-0.5 font-display text-sm font-bold text-teal">
            Attending
          </span>
        )}
      </Badge>

      <section aria-labelledby="resume-heading" className="rounded-[22px] bg-card p-5 shadow-panel">
        <h2 id="resume-heading" className="font-display text-lg font-semibold tracking-tight">
          {candidate ? "Update your resume" : "Add your resume"}
        </h2>
        {candidate && <p className="mt-1 text-sm text-ink-2">You can update it once every 6 hours.</p>}
        <input
          ref={input}
          type="file"
          accept="application/pdf,.pdf"
          className="sr-only"
          tabIndex={-1}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
          }}
        />
        <button
          type="button"
          disabled={!!busy || locked}
          onClick={() => input.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            if (!locked) setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            const file = e.dataTransfer.files[0];
            if (file) void upload(file);
          }}
          className={`mt-3 flex w-full flex-col items-center gap-1 rounded-2xl border-2 border-dashed px-4 py-6 text-center transition-colors ${
            over ? "border-violet bg-violet-soft" : "border-line hover:border-violet hover:bg-violet-soft/50"
          } disabled:hover:border-line disabled:hover:bg-transparent ${busy ? "disabled:cursor-wait" : "disabled:cursor-not-allowed"}`}
        >
          {busy ? (
            <>
              <span className="max-w-full truncate font-medium">{busy}</span>
              <span className="text-sm text-ink-2">Reading your resume. This can take a minute.</span>
              <span className="progress relative mt-3 h-1.5 w-full max-w-48 overflow-hidden rounded-full bg-violet-soft" />
            </>
          ) : locked ? (
            <>
              <span className="font-medium text-ink-2">Uploads are paused</span>
              <span className="text-sm text-ink-2">You can upload a new resume {timeFormat.format(new Date(updatableAt!))}.</span>
            </>
          ) : (
            <>
              <span className="font-medium">
                Drop a PDF here or <span className="text-violet underline underline-offset-4">choose a file</span>
              </span>
              <span className="text-sm text-ink-2">Up to 10 MB</span>
            </>
          )}
        </button>
        {error && (
          <p role="alert" className="mt-3 text-sm text-raspberry">
            {error}
          </p>
        )}

        {candidate && (
          <ul className="mt-5 flex flex-col divide-y divide-line border-t border-line">
            {resumes!.map((r) => (
              <li key={r.createdAt} className="py-3">
                <button
                  type="button"
                  onClick={() => show(r)}
                  aria-haspopup="dialog"
                  className="group flex w-full items-center justify-between gap-3 text-left"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className="shrink-0 text-violet">
                      <path d="M3 1.5 6.5 5 3 8.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <span className="truncate font-medium group-hover:text-violet-deep">{r.fileName}</span>
                  </span>
                  <span className="tnum shrink-0 text-sm text-ink-2">{dateFormat.format(new Date(r.createdAt))}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <dialog
        ref={details}
        aria-labelledby="resume-details-title"
        onClose={() => setShown(null)}
        className="m-auto max-h-[85vh] w-[calc(100%-2rem)] max-w-2xl overflow-hidden rounded-[22px] bg-card text-ink shadow-badge backdrop:bg-ink/40 backdrop:backdrop-blur-sm open:flex open:flex-col"
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-5">
          <div className="min-w-0">
            <h2 id="resume-details-title" className="font-display text-xl font-semibold tracking-tight">
              Your resume details
            </h2>
            {shown && (
              <p className="mt-1 truncate text-sm text-ink-2">
                {shown.fileName} · {dateFormat.format(new Date(shown.createdAt))}
              </p>
            )}
          </div>
          <form method="dialog">
            <button
              type="submit"
              aria-label="Close"
              className="-mt-1 -mr-2 grid size-9 place-items-center rounded-full text-ink-2 hover:bg-paper hover:text-ink"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
                <path d="M2 2l10 10M12 2 2 12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
          </form>
        </div>
        <div className="overflow-y-auto px-6 py-5 text-sm">{shown && <Markdown>{shown.reply}</Markdown>}</div>
      </dialog>
    </aside>
  );
}
