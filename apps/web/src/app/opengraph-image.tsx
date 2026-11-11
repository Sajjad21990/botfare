import { ImageResponse } from "next/og";
import { BOT_FARE_MARK_SVG } from "@/components/brand/bot-fare-mark";

/** The link preview for every page: the Admit-bot mark, the tagline, and a paid fare ticket. */

export const alt =
  "BotFare: Every bot pays its fare. AI agents pay websites a few cents a page through PayPal.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const PAPER = "#fff8e6";
const INK = "#1c1a16";
const YELLOW = "#ffd44d";
const MUTED = "#5c5344";
const SUCCESS = "#1a7f4b";

/** The ticket: notched sides, a hard ink offset shadow and a perforated stub, drawn as one SVG. */
const TICKET_W = 400;
const TICKET_H = 232;
const STUB_X = 292;

function ticketSvg(): string {
  const r = 18;
  const n = 22;
  const mid = TICKET_H / 2;
  const d = [
    `M${r} 0H${TICKET_W - r}A${r} ${r} 0 0 1 ${TICKET_W} ${r}`,
    `V${mid - n}A${n} ${n} 0 0 0 ${TICKET_W} ${mid + n}`,
    `V${TICKET_H - r}A${r} ${r} 0 0 1 ${TICKET_W - r} ${TICKET_H}`,
    `H${r}A${r} ${r} 0 0 1 0 ${TICKET_H - r}`,
    `V${mid + n}A${n} ${n} 0 0 0 0 ${mid - n}`,
    `V${r}A${r} ${r} 0 0 1 ${r} 0Z`,
  ].join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${TICKET_W + 20}" height="${TICKET_H + 20}" viewBox="-4 -4 ${TICKET_W + 20} ${TICKET_H + 20}"><path d="${d}" transform="translate(12 12)" fill="${INK}"/><path d="${d}" fill="${YELLOW}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/><path d="M${STUB_X} 26V${TICKET_H - 26}" stroke="${INK}" stroke-width="5" stroke-linecap="round" stroke-dasharray="0.1 13"/></svg>`;
}

const dataUrl = (svg: string) => `data:image/svg+xml;base64,${btoa(svg)}`;

export default function OpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        position: "relative",
        background: PAPER,
        color: INK,
        padding: "64px 72px",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", width: 640 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          {/* biome-ignore lint/performance/noImgElement: next/og renders plain <img> only */}
          <img src={dataUrl(BOT_FARE_MARK_SVG)} width={84} height={84} alt="" />
          <div style={{ fontSize: 48, letterSpacing: -1 }}>BotFare</div>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            marginTop: 72,
            fontSize: 84,
            lineHeight: 1.05,
            letterSpacing: -3,
          }}
        >
          <div style={{ display: "flex" }}>Every bot pays</div>
          <div style={{ display: "flex", alignItems: "center" }}>
            <span>its</span>
            <span
              style={{
                marginLeft: 20,
                marginRight: 2,
                padding: "0 10px 6px",
                background: YELLOW,
                borderRadius: 10,
              }}
            >
              fare
            </span>
            <span>.</span>
          </div>
        </div>

        <div
          style={{ display: "flex", marginTop: 40, fontSize: 36, lineHeight: 1.3, color: MUTED }}
        >
          AI agents pay websites a few cents a page through PayPal.
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          right: 64,
          top: 196,
          width: TICKET_W + 20,
          height: TICKET_H + 20,
          display: "flex",
          transform: "rotate(-6deg)",
        }}
      >
        {/* biome-ignore lint/performance/noImgElement: next/og renders plain <img> only */}
        <img
          src={dataUrl(ticketSvg())}
          width={TICKET_W + 20}
          height={TICKET_H + 20}
          alt=""
          style={{ position: "absolute", left: 0, top: 0 }}
        />
        <div
          style={{
            position: "absolute",
            left: 34,
            top: 28,
            width: STUB_X - 50,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div style={{ display: "flex", fontSize: 18, letterSpacing: 3 }}>ADMIT ONE AI AGENT</div>
          <div style={{ display: "flex", marginTop: 18, fontSize: 22, color: MUTED }}>Fare</div>
          <div style={{ display: "flex", fontSize: 104, lineHeight: 1, letterSpacing: -3 }}>3¢</div>
        </div>
        <div
          style={{
            position: "absolute",
            left: 162,
            top: 130,
            display: "flex",
            padding: "2px 10px",
            border: `4px solid ${SUCCESS}`,
            borderRadius: 8,
            color: SUCCESS,
            fontSize: 30,
            letterSpacing: 4,
            transform: "rotate(-12deg)",
          }}
        >
          PAID
        </div>
        {/* biome-ignore lint/performance/noImgElement: next/og renders plain <img> only */}
        <img
          src={dataUrl(BOT_FARE_MARK_SVG)}
          width={64}
          height={64}
          alt=""
          style={{ position: "absolute", left: STUB_X + 22, top: TICKET_H / 2 - 32 }}
        />
      </div>
    </div>,
    size,
  );
}
