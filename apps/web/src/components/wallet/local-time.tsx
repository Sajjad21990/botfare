"use client";

import { useEffect, useState } from "react";
import { formatLocalDate, formatLocalDateTime, formatUtcDateTime } from "./format";

/**
 * A timestamp in the viewer's timezone. The server (and the first client render) show UTC so
 * hydration matches; the local time replaces it right after.
 */
export function LocalTime({ iso, dateOnly = false }: { iso: string; dateOnly?: boolean }) {
  const [text, setText] = useState(() => (dateOnly ? iso.slice(0, 10) : formatUtcDateTime(iso)));
  useEffect(() => {
    setText(dateOnly ? formatLocalDate(iso) : formatLocalDateTime(iso));
  }, [iso, dateOnly]);
  return (
    <time dateTime={iso} title={formatUtcDateTime(iso)} className="whitespace-nowrap">
      {text}
    </time>
  );
}
