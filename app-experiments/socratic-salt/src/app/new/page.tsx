import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { PageHead } from "@/components/PageHead";
import { NewForm } from "./NewForm";

export default async function NewPage() {
  if (!(await auth()).userId) redirect("/");
  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-10 md:px-8 md:py-14">
      <PageHead title="New challenge." subtitle="One agent, one position to defend." back={{ href: "/", label: "Challenges" }} />
      <NewForm />
    </main>
  );
}
