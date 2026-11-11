import { cn } from "cn";

const INK = "#1c1a16";
const TICKET_YELLOW = "#ffd44d";
/** The same ticket as BotFareMark, so the marks read as one family. */
const TICKET_PATH =
  "M11 18H40A4 4 0 0 0 48 18H53A5 5 0 0 1 58 23V45A5 5 0 0 1 53 50H48A4 4 0 0 0 40 50H11A5 5 0 0 1 6 45V23A5 5 0 0 1 11 18Z";

/**
 * Fare Advisor's mark: the Admit-bot ticket with a rising price line printed on it, ending in a
 * price dot. Decorative only; the name goes in the text beside it.
 */
export function FareAdvisorMark({ className }: { className?: string }) {
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
        <path d="M13 42.5L19.5 35.5L25 39L33.5 30" />
        <circle cx={34} cy={29.5} r={4} fill={INK} stroke="none" />
      </g>
    </svg>
  );
}
