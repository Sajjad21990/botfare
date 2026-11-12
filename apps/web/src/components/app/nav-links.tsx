"use client";

import { DEMO_PERSONAS, type DemoPersona } from "@botfare/contracts";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Fragment, type MouseEvent, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * Top-level sections of the signed-in app, grouped by who uses them: agent owners, then
 * publishers. Grouped, never hidden: one PayPal login can be both. Each group names the demo
 * persona that owns it, so a judge signed in as one persona switches on the other group's links.
 */
const GROUPS = [
  {
    label: "For AI agent owners",
    persona: "agentOwner",
    links: [
      { href: "/wallet", label: "Wallet" },
      { href: "/agent", label: "Research agent" },
    ],
  },
  {
    label: "For websites",
    persona: "publisher",
    links: [
      { href: "/publisher", label: "Dashboard" },
      { href: "/publisher/analytics", label: "Analytics" },
      { href: "/publisher/disputes", label: "Disputes" },
    ],
  },
] as const;

/** The persona's role in lower case, for the switch hint: "agent owner", "publisher". */
function roleName(persona: DemoPersona): string {
  return DEMO_PERSONAS[persona].label.toLowerCase();
}

/** The demo persona whose group holds `pathname` (a link or one of its sub-pages), if any. */
function ownerOf(pathname: string): DemoPersona | undefined {
  return GROUPS.find((group) =>
    group.links.some((link) => pathname === link.href || pathname.startsWith(`${link.href}/`)),
  )?.persona;
}

/** `/publisher` is active only on itself; the other sections also on their sub-pages. */
function isActive(href: string, pathname: string): boolean {
  if (href === "/publisher") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function NavLinks({
  className,
  demoPersona,
}: {
  className?: string;
  /** The signed-in demo persona; unset for a real (Log in with PayPal) user, who gets plain links. */
  demoPersona?: DemoPersona;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const switching = useRef(false);
  /** The persona last switched to for a page (by click or by the effect below): one POST each. */
  const switchedTo = useRef<DemoPersona | null>(null);

  /** Signs in as the persona that owns `href`'s group (POST /api/session/persona), then goes there. */
  async function switchPersona(
    event: MouseEvent<HTMLAnchorElement>,
    persona: DemoPersona,
    href: string,
  ) {
    // A new-tab or modified click keeps the browser's own behaviour.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    if (switching.current) return;
    switching.current = true;
    switchedTo.current = persona;
    try {
      await fetch("/api/session/persona", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ persona }),
      });
    } catch {
      // Navigate anyway: the page still loads, as the current persona.
    } finally {
      switching.current = false;
    }
    router.push(href);
    router.refresh();
  }

  // The persona follows the page: browser Back or a typed URL into the other role's pages switches
  // too, so a judge never sees the other role's empty wallet or dashboard. Demo personas only.
  useEffect(() => {
    if (!demoPersona) return;
    const owner = ownerOf(pathname);
    if (!owner || owner === demoPersona) {
      switchedTo.current = null;
      return;
    }
    if (switching.current || switchedTo.current === owner) return;
    switchedTo.current = owner;
    fetch("/api/session/persona", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ persona: owner }),
    })
      .then((response) => {
        if (response.ok) router.refresh();
      })
      .catch(() => {
        // Stay as the current persona; the guard above keeps this to one try per page.
      });
  }, [pathname, demoPersona, router]);

  return (
    <nav
      aria-label="Main"
      className={cn(
        // Below sm the two groups wrap onto their own lines, so a phone never scrolls sideways.
        "flex min-w-0 flex-wrap items-stretch gap-x-4 gap-y-1 sm:flex-nowrap sm:gap-x-0 sm:overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
    >
      {GROUPS.map((group, index) => (
        <Fragment key={group.label}>
          {index > 0 ? (
            <span
              aria-hidden
              className="hidden h-4 w-px shrink-0 self-center bg-border sm:mx-2 sm:block"
            />
          ) : null}
          {/* biome-ignore lint/a11y/useSemanticElements: a labelled group of links, not a form fieldset */}
          <div role="group" aria-label={group.label} className="flex shrink-0 items-stretch">
            {group.links.map((link) => {
              const active = isActive(link.href, pathname);
              const switches = demoPersona !== undefined && demoPersona !== group.persona;
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  aria-current={active ? "page" : undefined}
                  title={
                    switches ? `Switches the demo to the ${roleName(group.persona)}` : undefined
                  }
                  onClick={
                    switches ? (event) => switchPersona(event, group.persona, link.href) : undefined
                  }
                  className={cn(
                    "relative inline-flex h-9 shrink-0 items-center rounded-md px-2.5 text-sm whitespace-nowrap transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:h-auto sm:px-3",
                    active ? "font-medium text-foreground" : "text-muted-foreground",
                  )}
                >
                  {link.label}
                  {active ? (
                    <span
                      aria-hidden
                      className="absolute inset-x-2 bottom-0 h-[3px] rounded-t-sm bg-brand sm:inset-x-2.5"
                    />
                  ) : null}
                </Link>
              );
            })}
          </div>
        </Fragment>
      ))}
    </nav>
  );
}
