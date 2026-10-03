import { cookies } from "next/headers";
import { UserIdForm } from "@/components/UserIdForm";
import { Wordmark } from "@/components/Wordmark";
import { readSession, SESSION_COOKIE } from "@/lib/session";

export default async function Home() {
  // Someone already wearing a badge sees it here, with a way back to their chat.
  const session = await readSession((await cookies()).get(SESSION_COOKIE)?.value);
  return (
    <div className="mx-auto flex min-h-dvh max-w-6xl flex-col px-5 lg:px-10">
      <main className="grid flex-1 grid-cols-[minmax(0,1fr)] content-start items-start gap-10 lg:grid-cols-[minmax(0,1fr)_400px] lg:gap-20">
        <section className="pt-10 lg:pt-24">
          <Wordmark className="text-violet" />
          <h1 className="mt-12 max-w-[14ch] font-display text-5xl leading-[0.98] font-bold tracking-[-0.03em] text-balance sm:text-6xl lg:text-7xl">
            Find your next role, or your next hire, at Devcon 8.
          </h1>
          <p className="mt-6 max-w-[46ch] text-lg text-ink-2">
            This is an unofficial app and not associated with Devcon. Upload your resume to get found. Or chat with our
            Matchmaker to find someone.
          </p>
        </section>
        <div className="pb-16">
          <UserIdForm session={session} />
        </div>
      </main>
      <footer className="flex flex-col items-center gap-4 border-t border-line py-8 text-center text-sm text-ink-2 sm:flex-row sm:items-center sm:justify-between sm:gap-2 sm:py-6 sm:text-left">
        <p className="sm:flex sm:flex-wrap sm:items-center sm:gap-x-1.5">
          Matchmaker agent is run by{" "}
          <a
            href="https://x.com/Always_Hungrie_"
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1.5 font-semibold whitespace-nowrap text-ink hover:text-violet-deep"
          >
            <XLogo />
            Always_Hungrie_
          </a>
        </p>
        {/* Phones: one card, the whole of it the link. */}
        <a
          href="https://github.com/AlwaysHungrie/salts-agent"
          target="_blank"
          rel="noreferrer noopener"
          className="flex max-w-sm items-center gap-3 rounded-2xl border border-line bg-card px-4 py-3 text-left font-medium text-ink transition-colors hover:border-violet hover:text-violet-deep sm:hidden"
        >
          <span className="shrink-0">
            <GitHubLogo />
          </span>
          Get free AI agents for yourself, friends and clients
        </a>
        {/* Wider screens: the line, with the GitHub mark as its link. */}
        <p className="hidden items-center gap-2 sm:flex">
          Get free AI agents for yourself, friends and clients
          <a
            href="https://github.com/AlwaysHungrie/salts-agent"
            target="_blank"
            rel="noreferrer noopener"
            aria-label="Get your agent on GitHub"
            className="grid size-9 place-items-center rounded-full text-ink hover:bg-card hover:text-violet-deep"
          >
            <GitHubLogo />
          </a>
        </p>
      </footer>
    </div>
  );
}

function XLogo() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" />
    </svg>
  );
}

function GitHubLogo() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden fill="currentColor">
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.76 2.69 1.25 3.35.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.62 1.59.23 2.76.11 3.05.74.81 1.18 1.84 1.18 3.1 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}
