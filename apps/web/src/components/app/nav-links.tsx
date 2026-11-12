"use client";

import { DEMO_PERSONAS, type DemoPersona } from "@botfare/contracts";
import { ShieldCheck } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Fragment, type MouseEvent, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * Top-level sections of the signed-in app, grouped by who uses them: agent owners, then
 * publishers. Grouped, never hidden: one PayPal login can be both. Each group names the demo
 * persona that owns it, so a judge signed in as one persona switches on the other group's links.
 * `label` names the group for screen readers; `short` is the small label shown before it on desktop.
 */
const GROUPS = [
  {
    label: "For AI agent owners",
    short: "Agent owner",
    persona: "agentOwner",
    links: [
      { href: "/wallet", label: "Wallet" },
      { href: "/agent", label: "Research agent" },
    ],
  },
  {
    label: "For websites",
    short: "Website owner",
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
        // Wraps instead of scrolling sideways: on a phone each group and the Verify chip get a line.
        "flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5 sm:gap-x-1",
        className,
      )}
    >
      {GROUPS.map((group, index) => (
        <Fragment key={group.label}>
          {index > 0 ? (
            <span
              aria-hidden
              className="hidden h-5 w-px shrink-0 bg-foreground/20 sm:mx-2 sm:block"
            />
          ) : null}
          {/* min-w-0 + flex-wrap: on the narrowest phones (320px) a group wraps inside itself too. */}
          {/* biome-ignore lint/a11y/useSemanticElements: a labelled group of links, not a form fieldset */}
          <div
            role="group"
            aria-label={group.label}
            className="flex min-w-0 flex-wrap items-center gap-1"
          >
            <span
              aria-hidden
              className="mr-1 hidden text-[11px] leading-4 font-semibold tracking-wider whitespace-nowrap text-muted-foreground uppercase lg:inline"
            >
              {group.short}
            </span>
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
                    "inline-flex h-9 shrink-0 items-center rounded-full border-[1.5px] px-3 text-[0.95rem] font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                    active
                      ? "border-brand-foreground bg-brand text-brand-foreground shadow-[2px_2px_0_var(--brand-foreground)]"
                      : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  {link.label}
                </Link>
              );
            })}
          </div>
        </Fragment>
      ))}
      {/* A plain link to the public receipt checker: it belongs to no role, so it never switches persona. */}
      <Link
        href="/verify"
        className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border-[1.5px] border-foreground px-3 text-[0.95rem] font-medium whitespace-nowrap text-foreground transition-colors outline-none hover:bg-ticket hover:text-ticket-foreground focus-visible:ring-3 focus-visible:ring-ring/50 sm:ml-auto"
      >
        <ShieldCheck aria-hidden className="size-4 text-success" />
        Verify a receipt
      </Link>
    </nav>
  );
}
