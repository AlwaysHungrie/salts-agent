/**
 * A conference badge: the clip slot, the violet band, and whatever is written on it.
 * `strap` hangs it from a lanyard of that height.
 */
export function Badge({
  children,
  strap,
  className = "",
}: {
  children: React.ReactNode;
  strap?: string;
  className?: string;
}) {
  return (
    <div className={className}>
      {strap && (
        <div aria-hidden className="flex flex-col items-center">
          <div className={`lanyard w-9 ${strap}`} />
          <div className="-mt-1 h-7 w-12 rounded-b-lg rounded-t-sm bg-gradient-to-b from-[#c9cfdd] to-[#a7afc4]" />
        </div>
      )}
      <div className={`overflow-hidden rounded-[22px] bg-card shadow-badge ${strap ? "-mt-3" : ""}`}>
        <div className="flex flex-col items-center gap-3 bg-violet px-6 pt-4 pb-5 text-white">
          <div className="badge-slot" aria-hidden />
          <span className="font-display text-sm font-semibold tracking-wide opacity-90">Devcon 8 Matchmaker</span>
        </div>
        <div className="relative px-6 pt-6 pb-7">{children}</div>
      </div>
    </div>
  );
}
