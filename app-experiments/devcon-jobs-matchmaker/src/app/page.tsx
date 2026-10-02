import { UserIdForm } from "@/components/UserIdForm";
import { Wordmark } from "@/components/Wordmark";

export default function Home() {
  return (
    <main className="mx-auto grid min-h-dvh max-w-6xl grid-cols-[minmax(0,1fr)] content-start items-start gap-10 px-5 lg:grid-cols-[minmax(0,1fr)_400px] lg:gap-20 lg:px-10">
      <section className="pt-10 lg:pt-24">
        <Wordmark className="text-violet" />
        <h1 className="mt-12 max-w-[14ch] font-display text-5xl leading-[0.98] font-bold tracking-[-0.03em] text-balance sm:text-6xl lg:text-7xl">
          Find your next role, or your next hire, at Devcon.
        </h1>
        <p className="mt-6 max-w-[46ch] text-lg text-ink-2">
          Add your resume to your badge so teams can find you. Then chat with the matchmaker to post a job or ask
          who&rsquo;s worth meeting.
        </p>
      </section>
      <div className="pb-16">
        <UserIdForm />
      </div>
    </main>
  );
}
