"use client";

import { useSearchParams } from "next/navigation";

import { CopyField } from "@/components/GuideFields";

/**
 * The callback URL the WhatsApp guide asks the reader to paste into Meta's dashboard.
 *
 * The guide page is built once, from markdown, so it cannot know which agent it is
 * being read for. The settings page links here with `?agent=<id>`, and this reads it
 * in the browser. `base` is the Worker's address, handed in by the server at build
 * time: the browser never learns `AGENT_URL`, because every API call goes through the
 * Next proxy.
 *
 * No agent id, no URL. The route carries the agent id in its path, so a guessed or
 * stale one points Meta at a different agent, whose verify token is a different
 * string: the handshake is refused and the dashboard blames the token. Rather than
 * hand out something that looks copyable, it says where the real one is.
 */
export function WhatsappCallback({ base }: { base: string }) {
  const agent = useSearchParams().get("agent");
  return <Field base={base} agent={agent} />;
}

/** What is drawn before the query string is readable, and when it has no agent. */
export function Field({ base, agent }: { base: string; agent: string | null }) {
  const url = `${base}/whatsapp/webhook/${agent ? encodeURIComponent(agent) : "agent-id-goes-here"}`;
  const web = (
    <Mono>https://salts-agent-app.vercel.app/a/&lt;find-agent-id-here&gt;</Mono>
  );
  return (
    <>
      <CopyField value={url} />
      <p className="text-faint mt-2 text-xs leading-[1.4]">
        {agent ? (
          <>
            Here <Mono>{agent}</Mono> is your agent ID. Verify it is the same agent ID
            you see when you are talking to your agent on the web {web}
          </>
        ) : (
          <>Find your agent ID in the URL when you are talking to your agent on the web {web}</>
        )}
      </p>
    </>
  );
}

const Mono = ({ children }: { children: React.ReactNode }) => (
  <code className="bg-canvas-soft rounded px-1.5 py-0.5 text-[0.85em]">{children}</code>
);
