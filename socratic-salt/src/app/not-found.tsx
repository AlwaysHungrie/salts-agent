import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-24 text-center">
      <h1 className="text-[32px] leading-[1.2] font-[650]">Not found.</h1>
      <p className="text-muted mt-2 text-sm leading-[1.43]">
        This challenge does not exist, or you are not on its list.
      </p>
      <Link href="/" className="text-ink mt-6 inline-block text-sm font-semibold underline underline-offset-2">
        Back to challenges
      </Link>
    </main>
  );
}
