import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { HERO } from "@/components/content";

/*
 * The card X, Telegram and WhatsApp show for a shared link: the salt mark and
 * the hero headline, in the page's ink on canvas.
 */

export const alt = `Salts: ${HERO.title.join(" ")}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const interSemiBold = readFile(join(process.cwd(), "assets/Inter-SemiBold.ttf"));

function Grain({ faint }: { faint?: boolean }) {
  return (
    <div
      style={{
        width: 20,
        height: 20,
        borderRadius: 6,
        background: faint ? "rgba(255,255,255,0.45)" : "#ffffff",
      }}
    />
  );
}

export default async function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "80px 88px",
          background:
            "radial-gradient(60% 60% at 50% 0%, #f3f3f3 0%, #ffffff 70%)",
          color: "#141414",
          fontFamily: "Inter",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <div
            style={{
              width: 96,
              height: 96,
              borderRadius: 30,
              background: "#141414",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
            }}
          >
            <div style={{ display: "flex", gap: 12 }}>
              <Grain />
              <Grain faint />
            </div>
            <div style={{ display: "flex", gap: 12 }}>
              <Grain faint />
              <Grain />
            </div>
          </div>
          <div style={{ fontSize: 48, letterSpacing: "-0.02em" }}>Salts</div>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            fontSize: 84,
            lineHeight: 1.04,
            letterSpacing: "-0.03em",
          }}
        >
          <div>{HERO.title[0]}</div>
          <div style={{ display: "flex", gap: 22 }}>
            <span>{HERO.title[1]}</span>
            <span style={{ color: "rgba(112,112,112,0.35)" }}>
              {HERO.title[2]}
            </span>
          </div>
        </div>

        <div style={{ fontSize: 30, color: "#707070" }}>
          {`salts.dev · ${HERO.eyebrow}`}
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Inter", data: await interSemiBold, style: "normal", weight: 600 },
      ],
    },
  );
}
