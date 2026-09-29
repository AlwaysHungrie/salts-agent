/** The Salt tile: four grains on ink. It turns a quarter when its link is hovered. */
export function Mark({ size = 32 }: { size?: number }) {
  return (
    <span className="relative grid shrink-0 place-items-center" style={{ width: size, height: size }}>
      <span
        aria-hidden
        className="bg-ink absolute inset-0 rounded-[10px] transition-transform duration-700 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:rotate-45 group-hover:scale-110"
      />
      <span className="relative grid grid-cols-2 gap-[3px]">
        <span className="size-[5px] rounded-[1.5px] bg-white" />
        <span className="size-[5px] rounded-[1.5px] bg-white/45" />
        <span className="size-[5px] rounded-[1.5px] bg-white/45" />
        <span className="size-[5px] rounded-[1.5px] bg-white" />
      </span>
    </span>
  );
}

export function Wordmark() {
  return (
    <span className="text-[17px] font-[650] tracking-[-0.02em]">
      Socratic <span className="text-muted">Salt</span>
    </span>
  );
}
