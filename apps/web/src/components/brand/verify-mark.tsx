import { cn } from "cn";

const INK = "#1c1a16";
const TICKET_YELLOW = "#ffd44d";
/** The same ticket as BotFareMark, so the marks read as one family. */
const TICKET_PATH =
  "M11 18H40A4 4 0 0 0 48 18H53A5 5 0 0 1 58 23V45A5 5 0 0 1 53 50H48A4 4 0 0 0 40 50H11A5 5 0 0 1 6 45V23A5 5 0 0 1 11 18Z";
/** A 12-lobe seal centred under the antenna: lobes on a radius-10 circle around (24, 34). */
const SEAL_PATH =
  "M24 24A3.2 3.2 0 0 1 29 25.34A3.2 3.2 0 0 1 32.66 29A3.2 3.2 0 0 1 34 34A3.2 3.2 0 0 1 32.66 39A3.2 3.2 0 0 1 29 42.66A3.2 3.2 0 0 1 24 44A3.2 3.2 0 0 1 19 42.66A3.2 3.2 0 0 1 15.34 39A3.2 3.2 0 0 1 14 34A3.2 3.2 0 0 1 15.34 29A3.2 3.2 0 0 1 19 25.34A3.2 3.2 0 0 1 24 24Z";

/**
 * The signed-receipt mark (/verify): the Admit-bot ticket with an ink seal printed on it and a
 * ticket-yellow check in the seal. Decorative only; the name goes in the text beside it.
 */
export function VerifyMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      aria-hidden
      className={cn("size-6 shrink-0", className)}
      fill="none"
      stroke={INK}
      strokeWidth={3.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <g transform="translate(0 4)">
        <path d="M24 18V10" />
        <circle cx={24} cy={7.5} r={3.6} fill={INK} stroke="none" />
        <path d={TICKET_PATH} fill={TICKET_YELLOW} />
        <path d="M44 25V44" strokeWidth={3} strokeDasharray="0.1 5.4" />
        <path d={SEAL_PATH} fill={INK} stroke="none" />
        <path d="M19.2 34.3L22.6 37.7L28.9 30.6" stroke={TICKET_YELLOW} strokeWidth={3.25} />
      </g>
    </svg>
  );
}
