import { cookies } from "next/headers";
import CyberScene from "@/components/CyberScene";
import { PoweredBySalts } from "@/components/PoweredBySalts";
import { VendingScreens } from "@/components/VendingScreens";
import WhatIsThis from "@/components/WhatIsThis";
import scene from "@/data/scene-panels.json";
import type { Panel } from "@/lib/sign-canvas";
import { readSession, SESSION_COOKIE } from "@/lib/session";

/** The front page (from mooned). The vending machine's screens sign the user in, then lead to search. */
export default async function Home() {
  const session = await readSession(
    (await cookies()).get(SESSION_COOKIE)?.value,
  );
  return (
    <main className="mooned fixed inset-0 bg-black">
      <CyberScene
        className="h-full w-full"
        plate="/scene/plate.webp"
        depth="/scene/depth.webp"
        wet="/scene/wet.webp"
        machine="/scene/vending-machine.png"
        panels={scene.panels as Panel[]}
        plateW={scene.w}
        plateH={scene.h}
      />
      <div className="pointer-events-none absolute inset-x-0 top-5 z-10 flex select-none flex-col items-center sm:inset-x-auto sm:left-10 sm:top-8 sm:items-start">
        {/* Sized together, so the tagline spans the logo's width: two columns as wide as M, each letter
            centred in its own, and the tagline sized, tracked and shifted to meet its ink edges (measured in Orbitron). */}
        <div className="header-shade relative flex flex-col text-7xl md:text-8xl">
          <h1
            aria-label="humans"
            className="inline-grid w-fit animate-logo-glow grid-cols-[0.93em_0.93em] justify-items-center gap-x-[0.06em] font-orbitron font-black uppercase leading-[0.9] text-white"
          >
            <span aria-hidden>h</span>
            <span aria-hidden>u</span>
            <span aria-hidden>m</span>
            <span aria-hidden>a</span>
            <span aria-hidden>n</span>
            <span aria-hidden>s</span>
          </h1>
          <p className="mt-3 ml-[0.35em] font-orbitron text-[0.14em] font-medium uppercase tracking-[0.29em] whitespace-nowrap text-white/85 [text-shadow:0_1px_2px_rgba(0,0,0,0.9),0_0_18px_rgba(0,0,0,0.65)]">
            at Devcon VIII
          </p>
        </div>
        <WhatIsThis />
      </div>
      <VendingScreens signedIn={session !== null} />
      <PoweredBySalts />
    </main>
  );
}
