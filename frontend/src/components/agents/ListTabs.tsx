/**
 * The agents/fleets switch: one white thumb that slides under the chosen label on a
 * soft track. Drawn only while there is a fleet to switch to.
 */
export function ListTabs({
  shown,
  onChange,
}: {
  shown: "agents" | "fleets";
  onChange: (tab: "agents" | "fleets") => void;
}) {
  return (
    <div
      role="tablist"
      className={`bg-canvas-soft relative mt-4 grid rounded-full p-1 w-60 grid-cols-2`}
    >
      <span
        aria-hidden
        className="bg-canvas absolute inset-y-1 left-1 rounded-full shadow-[0_1px_2px_rgba(0,0,0,0.06),0_2px_8px_rgba(0,0,0,0.06)] transition-transform duration-300 ease-[cubic-bezier(0.3,0.7,0.2,1)]"
        style={{
          width: "calc(50% - 4px)",
          transform: shown === "fleets" ? "translateX(100%)" : "translateX(0)",
        }}
      />

      {(["agents", "fleets"] as const).map((t) => (
        <button
          key={t}
          role="tab"
          aria-selected={shown === t}
          onClick={() => onChange(t)}
          className={`relative h-9 rounded-full text-sm font-semibold transition-colors duration-300 ${
            shown === t ? "text-ink" : "text-muted hover:text-ink"
          }`}
        >
          {t === "fleets" ? "Fleets" : "Agents"}
        </button>
      ))}
    </div>
  );
}
