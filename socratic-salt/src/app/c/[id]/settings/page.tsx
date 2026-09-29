import { notFound, redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { getSettings, mcpServers, modelCatalog } from "@/lib/challenges";
import { PageHead } from "@/components/PageHead";
import { card } from "@/components/ui";
import { addMcp, remove, removeMcp, save } from "@/app/actions";
import { DeleteButton } from "./DeleteButton";
import { McpForm } from "./McpForm";
import { SettingsForm } from "./SettingsForm";

export const dynamic = "force-dynamic";

export default async function SettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await auth()).userId) redirect(`/c/${id}`);
  // Meta settings are the creator's alone; anyone else gets a 404 from the Worker.
  const settings = await getSettings(id);
  if (!settings) notFound();
  const [models, servers] = await Promise.all([modelCatalog(), mcpServers(id)]);

  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-10 md:px-8 md:py-14">
      <PageHead title="Settings." subtitle={settings.name} back={{ href: `/c/${id}`, label: "Back to the debate" }} />

      <SettingsForm action={save.bind(null, id)} settings={settings} models={models} />

      <section className={`${card} mt-4`}>
        <div>
          <h2 className="text-xl leading-[1.3] font-[650]">MCP servers</h2>
          <p className="text-muted mt-1 text-sm leading-[1.43]">
            Tools the agent can call while it argues. Every challenger can make it call them, so
            prefer read-only servers.
          </p>
        </div>
        {servers.length > 0 && (
          <ul className="space-y-2">
            {servers.map((s) => (
              <li key={s.id} className="bg-canvas-soft flex items-start justify-between gap-4 rounded-2xl px-5 py-4">
                <div className="min-w-0">
                  <p className="font-semibold">{s.name}</p>
                  <p className="text-muted truncate text-xs">{s.url}</p>
                  <p className="text-faint mt-1 text-xs">
                    {s.last_error || `${s.tools.length} tool${s.tools.length === 1 ? "" : "s"}`}
                    {s.header_names.length > 0 && ` · header ${s.header_names.join(", ")}`}
                  </p>
                </div>
                <form action={removeMcp.bind(null, id, s.id)}>
                  <button className="text-muted hover:text-ink text-sm transition">Remove</button>
                </form>
              </li>
            ))}
          </ul>
        )}
        <McpForm action={addMcp.bind(null, id)} />
      </section>

      <section className={`${card} mt-4`}>
        <div>
          <h2 className="text-xl leading-[1.3] font-[650]">Delete</h2>
          <p className="text-muted mt-1 text-sm leading-[1.43]">
            Removes the agent and every challenger&rsquo;s conversation with it.
          </p>
        </div>
        <DeleteButton action={remove.bind(null, id)} />
      </section>
    </main>
  );
}
