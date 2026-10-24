"use client";

import { useState } from "react";
import { linkLabel, quoteBeliefs, type MyProfile } from "@/lib/people";
import { sendMessage } from "@/lib/reply";
import { Markdown } from "./Markdown";
import { SwitchBadge } from "./SwitchBadge";
import { TerminalInput } from "./TerminalInput";

/** One message's exchange: what was sent, and the reply as it arrives. */
type Transmission = { sent: string; reply: string; error: string };

/**
 * The user's profile: the saved, structured version people find, and a Save button that
 * publishes what they have told the agent since. Telling the agent about themselves is one
 * message at a time: it answers, and the next message starts over.
 */
export function ProfileEditor({ name, initial }: { name: string; initial: MyProfile | null }) {
  const [data, setData] = useState<MyProfile | null>(initial);
  const [loadError, setLoadError] = useState(initial ? "" : "Your profile couldn’t be loaded. Refresh the page.");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [tool, setTool] = useState("");
  const [shot, setShot] = useState<Transmission | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  const profile = data?.profile ?? null;
  const unsaved = !!data?.info.unsaved_changes;

  async function refresh() {
    const res = await fetch("/api/profile").catch(() => null);
    if (res?.ok) {
      setData((await res.json()) as MyProfile);
      setLoadError("");
    }
  }

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    setDraft("");
    setSending(true);
    setShot({ sent: text, reply: "", error: "" });
    try {
      await sendMessage("/api/profile/message", text, {
        onText: (d) => setShot((s) => s && { ...s, reply: s.reply + d }),
        onTool: setTool,
      });
    } catch (err) {
      setShot((s) => s && { ...s, error: err instanceof Error ? err.message : "Something went wrong. Try again." });
    } finally {
      setSending(false);
      await refresh();
    }
  }

  async function save() {
    setSaving(true);
    setSaveError("");
    try {
      const res = await fetch("/api/profile", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as MyProfile & { error?: string };
      if (!res.ok) throw new Error(body.error || "Your profile wasn’t saved. Try again.");
      setData(body);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Your profile wasn’t saved. Try again.");
    } finally {
      setSaving(false);
    }
  }

  function share() {
    const text = profile
      ? `I’m on Humans at Devcon VIII: ${profile.headline}. Find me, or anyone you’re looking for:`
      : "Finding the best people at Devcon VIII on Humans:";
    const url = `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(window.location.origin)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  const button =
    "h-11 rounded-full px-6 font-orbitron text-xs font-bold tracking-[0.2em] uppercase transition duration-300 disabled:cursor-not-allowed disabled:opacity-35 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/60";

  return (
    <div className="py-8">
      <h1 className="font-orbitron text-3xl font-black break-words uppercase leading-[0.95] text-white sm:text-5xl">
        {profile?.name ?? name}
      </h1>

      {/* The saved profile, as search shows it. */}
      {profile ? (
        <div className="mt-6 space-y-4">
          <p className="text-xl text-white sm:text-2xl">
            {profile.headline}
            {profile.location && <span className="text-white/40"> · {profile.location}</span>}
          </p>
          <p className="leading-relaxed text-white/65">{profile.summary}</p>
          {profile.beliefs.length > 0 && (
            <p className="text-white/80 italic">{quoteBeliefs(profile.beliefs)}</p>
          )}
          {profile.skills.length > 0 && <p className="text-sm text-white/45">{profile.skills.join(" · ")}</p>}
          {profile.links.length > 0 && (
            <ul className="flex flex-wrap gap-x-4 gap-y-1">
              {profile.links.map((l) => (
                <li key={l}>
                  <a
                    href={l}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-[#5dff8f]/90 underline decoration-[#5dff8f]/30 underline-offset-4 hover:decoration-[#5dff8f]"
                  >
                    {linkLabel(l)}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <p className="mt-6 text-white/55">
          {unsaved ? "Save to create your profile." : "Tell us who you are, what you work on and what you believe in."}
        </p>
      )}
      {unsaved && profile && <p className="mt-4 text-sm text-[#ffcf5d]/90">You have unsaved changes.</p>}

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || sending || !unsaved}
          className={`${button} bg-white text-black hover:opacity-90`}
        >
          {saving ? "Saving…" : unsaved ? "Save" : "Saved"}
        </button>
        <button type="button" onClick={share} className={`${button} border border-white/25 text-white hover:border-white/60`}>
          Share on X
        </button>
      </div>
      {(saveError || loadError) && (
        <p role="alert" className="mt-4 text-[#ff7a9a]">
          {saveError || loadError}
        </p>
      )}

      {/* Telling the agent: one message at a time. */}
      <div className="mt-14">
        <TerminalInput
          id="tell"
          label="Tell us about yourself"
          value={draft}
          onChange={setDraft}
          onSubmit={() => void send()}
          disabled={sending}
          placeholder="Tell us about yourself…"
          className="text-xl leading-snug sm:text-2xl"
        />
        {shot && (
          <div className="rise-in mt-6">
            {shot.reply && <Markdown className="md-dark">{shot.reply}</Markdown>}
            {sending && (
              <p className="terminal-text text-xl leading-none">
                {tool ? "SAVING YOUR NOTE" : "THINKING"}
                <span className="terminal-cursor" aria-hidden />
              </p>
            )}
            {shot.error && (
              <p role="alert" className="text-[#ff7a9a]">
                {shot.error}
              </p>
            )}
          </div>
        )}
      </div>

      <div className="mt-auto pt-16">
        <SwitchBadge />
      </div>
    </div>
  );
}
