"use client";

import { useEffect, useRef, useState } from "react";
import { Badge } from "./Badge";
import { Markdown } from "./Markdown";
import { resumeProblem } from "@/lib/rules";

type Resume = { fileName: string; bytes: number; reply: string; createdAt: string };

async function fetchResumes(base: string): Promise<Resume[] | null> {
  const res = await fetch(base, { cache: "no-store" }).catch(() => null);
  return res?.ok ? ((await res.json()) as { resumes: Resume[] }).resumes : null;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/** The user's badge, and the resumes pinned to it. */
export function ResumePanel({ userId }: { userId: string }) {
  const base = `/api/users/${encodeURIComponent(userId)}/resume`;
  const input = useRef<HTMLInputElement>(null);
  const [resumes, setResumes] = useState<Resume[] | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [over, setOver] = useState(false);

  useEffect(() => {
    let live = true;
    void fetchResumes(base).then((list) => {
      if (live) setResumes(list ?? []);
    });
    return () => {
      live = false;
    };
  }, [base]);

  async function upload(file: File) {
    if (busy) return;
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
      else setResumes((await fetchResumes(base)) ?? []);
    } catch {
      setError("Your resume wasn’t added. Check your connection and try again.");
    } finally {
      setBusy("");
      if (input.current) input.current.value = "";
    }
  }

  const candidate = !!resumes?.length;

  return (
    <aside className="flex flex-col gap-6 lg:min-h-0 lg:overflow-y-auto lg:pb-2">
      <Badge strap="h-6" className="mx-auto w-full max-w-[340px]">
        <p className="text-sm text-ink-2">Hello, I&rsquo;m</p>
        <p className="mt-1 font-display text-3xl font-bold tracking-tight break-all text-violet">{userId}</p>
        <p className="mt-4 text-sm text-ink-2">
          {resumes === null
            ? " "
            : candidate
              ? "Teams can find you through the matchmaker."
              : "Add your resume so teams can find you."}
        </p>
        {candidate && (
          <span className="stamp absolute top-4 right-4 rounded-md border-2 border-teal px-2 py-0.5 font-display text-sm font-bold text-teal">
            Candidate
          </span>
        )}
      </Badge>

      <section aria-labelledby="resume-heading" className="rounded-[22px] bg-card p-5 shadow-panel">
        <h2 id="resume-heading" className="font-display text-lg font-semibold tracking-tight">
          {candidate ? "Update your resume" : "Add your resume"}
        </h2>
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
          disabled={!!busy}
          onClick={() => input.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
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
          } disabled:cursor-wait disabled:hover:border-line disabled:hover:bg-transparent`}
        >
          {busy ? (
            <>
              <span className="max-w-full truncate font-medium">{busy}</span>
              <span className="text-sm text-ink-2">Reading your resume. This can take a minute.</span>
              <span className="progress relative mt-3 h-1.5 w-full max-w-48 overflow-hidden rounded-full bg-violet-soft" />
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
                <details className="group">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
                    <span className="flex min-w-0 items-center gap-2">
                      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className="shrink-0 text-violet transition-transform group-open:rotate-90">
                        <path d="M3 1.5 6.5 5 3 8.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      <span className="truncate font-medium">{r.fileName}</span>
                    </span>
                    <span className="tnum shrink-0 text-sm text-ink-2">{dateFormat.format(new Date(r.createdAt))}</span>
                  </summary>
                  <div className="mt-2 rounded-xl bg-paper p-3 text-sm">
                    <Markdown>{r.reply}</Markdown>
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}
