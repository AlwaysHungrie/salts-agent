"use client";

import { PageNotice } from "@/components/PageNotice";
import { useIdentity } from "@/lib/identity";
import { claim } from "@/lib/cache";

/**
 * Stop an agent page drawing for somebody who is not signed in.
 *
 * It says so and waits. Nothing redirects: a page that navigates away on its own takes
 * the explanation with it, and the way out is a button that was always going to be
 * faster to read than to be surprised by.
 *
 * This is for the visitor, not for the data. Nothing on these pages is theirs to see
 * either way: every byte arrives from a route handler that forwards to the Worker, and
 * the Worker answers nobody it cannot identify and shows no agent to an address that is
 * not on its list. What this prevents is a blank frame full of failed requests where a
 * way in should be.
 */
export default function AgentLayout({ children }: LayoutProps<"/a/[agentId]">) {
  const { ready, signedIn, email } = useIdentity();

  // Nothing is drawn until Clerk has loaded, so the first paint does not guess.
  if (!ready) {
    return (
      <div className="bg-canvas text-ink flex min-h-screen items-center justify-center">
        <p className="text-muted text-sm leading-[1.43]">Loading…</p>
      </div>
    );
  }

  if (!signedIn) {
    return <PageNotice message="You need to be signed in to access this page." />;
  }

  // Before the page renders, so it never reads another account's cache.
  claim(email);
  return <>{children}</>;
}
