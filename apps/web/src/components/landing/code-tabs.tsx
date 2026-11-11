"use client";

import { type ReactNode, useId, useState } from "react";
import styles from "./landing.module.css";

export interface CodeTab {
  id: string;
  label: string;
  panel: ReactNode;
}

/**
 * A two-button switch between code panels. Every panel is rendered on the server and the first is
 * shown, so without JavaScript the page still shows the first snippet.
 */
export function CodeTabs({ tabs, label }: { tabs: CodeTab[]; label: string }) {
  const [active, setActive] = useState(tabs[0]?.id);
  const baseId = useId();
  return (
    <div>
      <fieldset className="inline-flex rounded-lg border-[1.5px] border-foreground p-0.5">
        <legend className="sr-only">{label}</legend>
        {tabs.map((tab) => {
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              type="button"
              aria-pressed={selected}
              aria-controls={`${baseId}-${tab.id}`}
              onClick={() => setActive(tab.id)}
              className={`${styles.focusRing} rounded-md px-3 py-1.5 text-sm font-semibold whitespace-nowrap transition-colors ${
                selected ? "bg-foreground text-brand" : "text-foreground hover:bg-muted"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </fieldset>
      {tabs.map((tab) => (
        <div key={tab.id} id={`${baseId}-${tab.id}`} hidden={tab.id !== active} className="mt-4">
          {tab.panel}
        </div>
      ))}
    </div>
  );
}
