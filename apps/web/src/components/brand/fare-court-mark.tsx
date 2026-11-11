import { cn } from "cn";

const INK = "#1c1a16";
const TICKET_YELLOW = "#ffd44d";
/** The same ticket as BotFareMark, so the marks read as one family. */
const TICKET_PATH =
  "M11 18H40A4 4 0 0 0 48 18H53A5 5 0 0 1 58 23V45A5 5 0 0 1 53 50H48A4 4 0 0 0 40 50H11A5 5 0 0 1 6 45V23A5 5 0 0 1 11 18Z";

/**
 * Fare Court's mark: the Admit-bot ticket with a balance scale printed on it. The scale's post runs
 * up through the ticket into the bot's antenna. Decorative only; the name goes in the text beside it.
 */
export function FareCourtMark({ className }: { className?: string }) {
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
        <path d="M24 18V42M19.5 42H28.5M15 26.5H33" />
        <path
          d="M15 26.5L12.4 35M15 26.5L17.6 35M33 26.5L30.4 35M33 26.5L35.6 35"
          strokeWidth={2.5}
        />
        <path d="M12 35H18A3 3 0 0 1 12 35ZM30 35H36A3 3 0 0 1 30 35Z" fill={INK} />
      </g>
    </svg>
  );
}
