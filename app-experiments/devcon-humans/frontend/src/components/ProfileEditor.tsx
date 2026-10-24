"use client";

import { useState } from "react";
import type { MyProfile } from "@/lib/people";
import { sendMessage, visibleReply } from "@/lib/reply";
import { Markdown } from "./Markdown";
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
      const tools = await sendMessage("/api/profile/message", text, {
        onText: (d) => setShot((s) => s && { ...s, reply: s.reply + d }),
        onTool: setTool,
        // Show the change as soon as it is stored, not when the reply ends.
        onToolDone: (name, ok) => {
          if (ok && /(add_info|delete_info)$/.test(name)) void refresh();
        },
      });
      // The reply alone is no proof: only a finished add or delete changed the profile.
      if (!tools.some((t) => /(add_info|delete_info)$/.test(t)))
        setShot((s) => s && { ...s, error: "Nothing was saved to your profile. Send it again." });
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
      ? `At Devcon VIII? Come find me.\n\n${profile.headline}.\n\nHumans finds you the people at Devcon worth meeting:`
      : "At Devcon VIII? Humans finds you the people worth meeting:";
    const url = `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(window.location.origin)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  const button =
    "h-11 rounded-full px-6 font-orbitron text-xs font-bold tracking-[0.2em] uppercase transition duration-300 disabled:cursor-not-allowed disabled:opacity-35 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/60";

  return (
    <div className="py-8">
      {/* Everything to do sits on top: tell the agent, save, share. */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
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
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || sending || !unsaved}
            className={`${button} bg-white text-black hover:opacity-90 ${unsaved ? "shadow-[0_0_24px_rgb(93_255_143/0.45)] ring-2 ring-[#5dff8f]" : ""}`}
          >
            {saving ? "Saving…" : unsaved ? "Save" : "Saved"}
          </button>
          <button type="button" onClick={share} className={`${button} border border-white/25 text-white hover:border-white/60`}>
            Share on X
          </button>
        </div>
      </div>
      {unsaved && (
        <p className="terminal-text mt-4 text-lg leading-none text-[#ffcf5d] [text-shadow:0_0_8px_rgb(255_207_93/0.45)]">
          &gt; NOT IN YOUR PROFILE YET. SAVE TO ADD IT.
        </p>
      )}
      {(saveError || loadError) && (
        <p role="alert" className="mt-4 text-[#ff7a9a]">
          {saveError || loadError}
        </p>
      )}
      {shot && (
        <div className="rise-in mt-5">
          {visibleReply(shot.reply) && <Markdown className={`md-dark ${sending ? "streaming" : ""}`}>{visibleReply(shot.reply)}</Markdown>}
          {sending && !visibleReply(shot.reply) && (
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

      <h1 className="mt-12 font-orbitron text-4xl font-black break-words uppercase leading-[0.95] text-white sm:text-6xl">
        {profile?.name ?? name}
      </h1>

      {/* The saved profile, as search shows it. */}
      <section aria-label="Your saved profile" className="mt-8 rounded-2xl border border-white/10 bg-white/[0.035] p-6 backdrop-blur-md sm:p-8">
        {profile ? (
          <>
            <p className="text-xl text-white sm:text-2xl">
              {profile.headline}
              {/* Not when the headline already says where. */}
              {profile.location && !profile.headline.includes(profile.location) && <span className="text-white/40"> · {profile.location}</span>}
            </p>
            {/* Written from everything they said: bold labels, a line or bullets under each. */}
            <Markdown breaks className="md-dark profile-page mt-6">
              {profile.page ?? profile.summary}
            </Markdown>
          </>
        ) : (
          <p className="py-6 text-center text-white/55">
            {unsaved
              ? "Save to create your profile and let people find you."
              : "Tell us who you are, what you work on and what you believe in. Then save, and people can find you."}
          </p>
        )}
      </section>
    </div>
  );
}
