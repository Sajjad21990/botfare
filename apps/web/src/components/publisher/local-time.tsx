"use client";

import { useEffect, useState } from "react";
import { formatDateTime } from "./format";

/** A timestamp in the viewer's time zone. Rendered after mount so server and browser agree. */
export function LocalTime({ iso }: { iso: string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => setText(formatDateTime(iso)), [iso]);
  return (
    <time dateTime={iso} title={iso}>
      {text ?? " "}
    </time>
  );
}
