import { MetaSettingsForm } from "@/components/MetaSettings";
import { type Capability, EMPTY_META, type McpCatalogEntry, type MetaSettings, type ModelOption } from "@/lib/agent";
import { apiFetch, useIdentity } from "@/lib/identity";
import { useEffect, useRef, useState } from "react";

/**
 * Who the agent is, then what it is: name first, its settings second.
 *
 * An agent made on its own belongs to whoever is making it and to nobody else —
 * there is no access list to fill in, because the answer is always the address
 * already signed in. Ticking the fleet box is what turns this into a list: a fleet
 * name, a column of addresses, and one agent made for each of them.
 *
 * The second step is meta settings, which is the whole of a fleet's configuration —
 * every agent in the fleet is created holding it. A lone agent has nobody to hold
 * settings *for*, so it is asked only for the OpenRouter key that makes it able to
 * answer at all.
 */
export function NewAgent({
  busy,
  onCancel,
  onCreate,
}: {
  busy: boolean;
  onCancel: () => void;
  /** Resolves to an error to show in the dialog, or null once the agents exist. */
  onCreate: (
    name: string,
    emails: string,
    meta: MetaSettings,
    fleetName: string,
  ) => Promise<string | null>;
}) {
  const { email: ownEmail } = useIdentity();
  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState("");
  /** Whether this call is making a fleet rather than one agent. */
  const [fleet, setFleet] = useState(false);
  const [fleetName, setFleetName] = useState("");
  /**
   * The fleet's addresses as typed: space-, comma- or newline-separated. One agent
   * is made per address, and that address is its only member.
   */
  const [fleetEmails, setFleetEmails] = useState("");
  const [meta, setMeta] = useState<MetaSettings>(EMPTY_META);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [mcpCatalog, setMcpCatalog] = useState<McpCatalogEntry[]>([]);
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    field.current?.focus();
  }, []);

  // The catalogues the second step picks from. There is no agent to hang them off
  // yet, so they come from the deployment rather than from one agent's config.
  useEffect(() => {
    void (async () => {
      const res = await apiFetch("/api/agents/catalog", { cache: "no-store" });
      const payload = (await res.json().catch(() => null)) as {
        models?: ModelOption[];
        mcp_catalog?: McpCatalogEntry[];
        capabilities?: Capability[];
      } | null;
      setModels(payload?.models ?? []);
      setMcpCatalog(payload?.mcp_catalog ?? []);
      setCapabilities(payload?.capabilities ?? []);
    })();
  }, []);

  /**
   * The addresses the fleet box holds, in the order they were typed — and what was
   * typed that is not one.
   *
   * Split apart here because the Worker drops anything that is not an address
   * without a word, so a fleet made from a box with a typo in it would quietly come
   * back one agent short. The count below is the number of agents that will exist,
   * and the rejected words are named so the typo can be found.
   */
  const typed = fleetEmails
    .split(/[\s,;]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  // The same shape check the Worker's `normalizeEmails` applies, so the two agree on
  // what counts. Repeats are kept: the same address twice is two agents for that
  // person, which the Worker makes as asked.
  const isEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
  const members = typed.filter(isEmail);
  const rejected = typed.filter((e) => !isEmail(e));

  /**
   * Who the agents being created are for. A fleet is the list that was typed; a lone
   * agent is whoever is making it, which is the only answer available.
   */
  const emails = fleet ? members.join("\n") : ownEmail;

  const ready =
    name.trim() !== "" &&
    (fleet ? fleetName.trim() !== "" && members.length > 0 : !!ownEmail);

  const submit = async () => {
    const cleaned = name.trim();
    if (!cleaned || busy) return;
    setError(
      await onCreate(cleaned, emails, meta, fleet ? fleetName.trim() : ""),
    );
  };

  if (step === 2) {
    return (
      <div
        className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 px-5 py-10"
        onClick={onCancel}
      >
        <div
          className={`bg-canvas text-ink my-auto w-full rounded-[20px] px-6 py-6 shadow-xl ${fleet ? "max-w-lg" : "max-w-sm"}`}
          onClick={(e) => e.stopPropagation()}
        >
          <p className="text-faint text-xs leading-[1.33]">Step 2 of 2</p>
          <p className="text-lg font-semibold leading-[1.38]">
            {fleet ? "Meta settings" : "OpenRouter key"}
          </p>
          <p className="text-muted mt-1 text-xs font-light leading-[1.33]">
            {fleet
              ? `Set the defaults for every agent in ${fleetName.trim() || "this fleet"}, and choose what its owner can change. A locked setting will not be shown to the owner for configuration.`
              : "Every model call this agent makes is billed to this key. You can add it now or even change it later in settings."}
          </p>

          <div className="mt-4">
            <MetaSettingsForm
              meta={meta}
              onChange={setMeta}
              models={models}
              mcpCatalog={mcpCatalog}
              capabilities={capabilities}
              onlyOpenrouter={!fleet}
            />
          </div>

          {error && <p className="mt-3 text-xs leading-[1.33]">{error}</p>}

          <div className="border-hairline-soft mt-2 flex justify-end gap-2 border-t pt-5">
            <button
              onClick={() => setStep(1)}
              className="border-hairline text-ink hover:bg-canvas-soft h-10 rounded-full border px-5 text-sm font-semibold transition"
            >
              Back
            </button>
            <button
              onClick={() => void submit()}
              disabled={busy}
              className="bg-ink text-on-primary h-10 rounded-full px-5 text-sm font-semibold transition hover:opacity-85 disabled:opacity-40"
            >
              {busy ? "Creating…" : "Create"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 px-5 py-10"
      onClick={onCancel}
    >
      <div
        className="bg-canvas my-auto w-full max-w-sm rounded-[20px] px-6 py-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-faint text-xs leading-[1.33]">Step 1 of 2</p>
        <p className="text-lg font-semibold leading-[1.38]">
          Create a new agent
        </p>
        <label className="mt-5 block">
          <span className="block text-sm font-semibold leading-[1.43]">
            Name
          </span>
          <input
            ref={field}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && ready) setStep(2);
              if (e.key === "Escape") onCancel();
            }}
            maxLength={60}
            placeholder="Research assistant"
            className="bg-field placeholder:text-faint mt-2 w-full rounded-2xl px-4 py-3 text-sm outline-none"
          />
        </label>

        <label className="mt-4 flex cursor-pointer items-start gap-2">
          <input
            type="checkbox"
            checked={fleet}
            onChange={(e) => setFleet(e.target.checked)}
            className="mt-1 h-4 w-4 shrink-0"
          />
          <span className="min-w-0">
            <span className="block text-sm font-semibold leading-[1.43]">
              Create a fleet of agents
            </span>
            <span className="text-muted block text-xs font-light leading-[1.33]">
              Deploy multiple agents, 1 per user that can share an OpenRouter
              key and can be managed by you.
            </span>
          </span>
        </label>

        {fleet && (
          <FleetFields
            name={fleetName}
            onName={setFleetName}
            emails={fleetEmails}
            onEmails={setFleetEmails}
            members={members.length}
            rejected={rejected.length}
            onCancel={onCancel}
          />
        )}

        {error && <p className="mt-3 text-xs leading-[1.33]">{error}</p>}

        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="border-hairline text-ink hover:bg-canvas-soft h-10 rounded-full border px-5 text-sm font-semibold transition"
          >
            Cancel
          </button>
          <button
            onClick={() => setStep(2)}
            disabled={busy || !ready}
            className="bg-ink text-on-primary h-10 rounded-full px-5 text-sm font-semibold transition hover:opacity-85 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}

/** The fleet's own fields: its name, and one address per agent to be made. */
function FleetFields({
  name,
  onName,
  emails,
  onEmails,
  members,
  rejected,
  onCancel,
}: {
  name: string;
  onName: (value: string) => void;
  emails: string;
  onEmails: (value: string) => void;
  /** How many valid addresses were typed, and how many words were not addresses. */
  members: number;
  rejected: number;
  onCancel: () => void;
}) {
  return (
    <>
      <label className="mt-4 block">
        <span className="block text-sm font-semibold leading-[1.43]">
          Fleet name
        </span>
        <input
          value={name}
          onChange={(e) => onName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onCancel();
          }}
          maxLength={60}
          placeholder="Sales team"
          className="bg-field placeholder:text-faint mt-2 w-full rounded-2xl px-4 py-3 text-sm outline-none"
        />
      </label>

      <label className="mt-4 block">
        <span className="block text-sm font-semibold leading-[1.43]">
          User Emails
        </span>
        <span className="text-muted block text-xs font-light leading-[1.33]">
          Space separated. You can manage agents individually or as a
          fleet but only a user will have access to their agent.
        </span>
        <textarea
          value={emails}
          onChange={(e) => onEmails(e.target.value)}
          rows={3}
          placeholder="ana@example.com ben@example.com"
          className="bg-field placeholder:text-faint mt-2 w-full resize-none rounded-2xl px-4 py-3 text-sm outline-none"
        />
        <span className="text-faint text-xs leading-[1.33]">
          {members === 0
            ? "Add at least one address."
            : `Creating ${members} agent${members === 1 ? "" : "s"}.`}
        </span>{" "}
        {rejected > 0 && (
          <span className="text-faint text-xs leading-[1.33]">
            (Found {rejected} invalid address)
          </span>
        )}
      </label>
    </>
  );
}
