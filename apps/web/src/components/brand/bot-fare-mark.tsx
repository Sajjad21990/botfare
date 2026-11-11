import { cn } from "cn";

/**
 * BotFare's mark, "Admit-bot": a bot face printed on an admit-one ticket, the antenna through the
 * top edge and a perforated stub on the right. Two-tone (ticket yellow and ink) on any background;
 * the same drawing is app/icon.svg.
 */
export function BotFareMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      aria-hidden
      className={cn("size-6 shrink-0", className)}
      fill="none"
      stroke="#1c1a16"
      strokeWidth={3.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <g transform="translate(0 4)">
        <path d="M24 18V10" />
        <circle cx={24} cy={7.5} r={3.6} fill="#1c1a16" stroke="none" />
        <path
          d="M11 18H40A4 4 0 0 0 48 18H53A5 5 0 0 1 58 23V45A5 5 0 0 1 53 50H48A4 4 0 0 0 40 50H11A5 5 0 0 1 6 45V23A5 5 0 0 1 11 18Z"
          fill="#ffd44d"
        />
        <path d="M44 25V44" strokeWidth={3} strokeDasharray="0.1 5.4" />
        <circle cx={18} cy={31} r={3.3} fill="#1c1a16" stroke="none" />
        <circle cx={30} cy={31} r={3.3} fill="#1c1a16" stroke="none" />
        <path d="M18.5 39Q24 43.5 29.5 39" />
      </g>
    </svg>
  );
}
