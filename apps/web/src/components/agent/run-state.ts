import type { AnswerManifest } from "@botfare/contracts/receipts";
import type {
  ResearchCitation,
  ResearchEvent,
  SourceSummary,
  WireStage,
} from "@/lib/server/research-events";

/** Everything the /agent page shows about one run, folded from the event stream. */

type EventOf<T extends ResearchEvent["type"]> = Extract<ResearchEvent, { type: T }>;

export type TimelineEntry =
  | { kind: "note"; id: string; source: "thinking" | "text"; text: string }
  | { kind: "sources"; id: string; toolCallId: string; sources: SourceSummary[] }
  | ({ kind: "offer"; id: string } & Omit<EventOf<"offer">, "type">)
  | ({ kind: "decision"; id: string } & Omit<EventOf<"decision">, "type">)
  | ({ kind: "refusal"; id: string } & Omit<EventOf<"refusal">, "type">)
  | ({ kind: "payment"; id: string } & Omit<EventOf<"payment">, "type">)
  | ({
      kind: "dispute";
      id: string;
      /** Filled in when BotFare answers; null while the judge is deciding. */
      outcome: Omit<EventOf<"dispute-outcome">, "type" | "toolCallId" | "receiptId" | "url"> | null;
    } & Omit<EventOf<"dispute-filed">, "type">)
  | ({ kind: "tool-error"; id: string } & Omit<EventOf<"tool-error">, "type">);

export interface WireTrace {
  url: string;
  required?: Extract<WireStage, { stage: "payment-required" }>;
  signature?: Extract<WireStage, { stage: "payment-signature" }>;
  response?: Extract<WireStage, { stage: "payment-response" }>;
}

export type RunStatus = "idle" | "starting" | "running" | "finished" | "stopped" | "failed";

export interface RunView {
  status: RunStatus;
  question: string;
  budgetCents: number;
  maxPerRequestCents: number;
  maxToolCalls: number;
  model: string | null;
  agentKeyId: string | null;
  spentCents: number;
  toolCalls: number;
  entries: TimelineEntry[];
  /** x402 handshake per tool call. */
  wire: Record<string, WireTrace>;
  /** `manifest`: the signed sources manifest ("Verify sources"); null when nothing is cited. */
  answer: { answer: string; citations: ResearchCitation[]; manifest: AnswerManifest | null } | null;
  error: { code: string; message: string } | null;
  /** True while the last timeline entry is a note still receiving deltas. */
  noteOpen: boolean;
}

export function initialRun(
  budgetCents: number,
  maxPerRequestCents = 10,
  maxToolCalls = 12,
): RunView {
  return {
    status: "idle",
    question: "",
    budgetCents,
    maxPerRequestCents,
    maxToolCalls,
    model: null,
    agentKeyId: null,
    spentCents: 0,
    toolCalls: 0,
    entries: [],
    wire: {},
    answer: null,
    error: null,
    noteOpen: false,
  };
}

export type RunAction =
  | { type: "start"; question: string; budgetCents: number }
  | { type: "event"; event: ResearchEvent }
  | { type: "failed"; code: string; message: string }
  | { type: "stopped" };

let counter = 0;
const nextId = (prefix: string) => `${prefix}-${++counter}`;

function appendNote(view: RunView, source: "thinking" | "text", delta: string): RunView {
  const last = view.entries[view.entries.length - 1];
  if (view.noteOpen && last?.kind === "note" && last.source === source) {
    const entries = view.entries.slice(0, -1);
    entries.push({ ...last, text: last.text + delta });
    return { ...view, entries };
  }
  return {
    ...view,
    noteOpen: true,
    entries: [...view.entries, { kind: "note", id: nextId("note"), source, text: delta }],
  };
}

function push(view: RunView, entry: TimelineEntry): RunView {
  return { ...view, noteOpen: false, entries: [...view.entries, entry] };
}

export function runReducer(view: RunView, action: RunAction): RunView {
  switch (action.type) {
    case "start":
      return {
        ...initialRun(action.budgetCents, view.maxPerRequestCents, view.maxToolCalls),
        status: "starting",
        question: action.question,
      };
    case "failed":
      return {
        ...view,
        status: "failed",
        noteOpen: false,
        error: { code: action.code, message: action.message },
      };
    case "stopped":
      return view.status === "running" || view.status === "starting"
        ? { ...view, status: "stopped", noteOpen: false }
        : view;
    case "event":
      return applyEvent(view, action.event);
  }
}

function applyEvent(view: RunView, event: ResearchEvent): RunView {
  switch (event.type) {
    case "run-started":
      return {
        ...view,
        status: "running",
        question: event.question,
        budgetCents: event.budgetCents,
        maxPerRequestCents: event.maxPerRequestCents,
        maxToolCalls: event.maxToolCalls,
        model: event.model,
        agentKeyId: event.agentKeyId,
      };
    case "thinking":
      return appendNote(view, "thinking", event.delta);
    case "text":
      return appendNote(view, "text", event.delta);
    case "tool-call":
      return { ...view, toolCalls: event.callsUsed, noteOpen: false };
    case "sources":
      return push(view, {
        kind: "sources",
        id: nextId("sources"),
        toolCallId: event.toolCallId,
        sources: event.sources,
      });
    case "offer":
    case "decision":
    case "refusal":
    case "payment":
    case "tool-error": {
      const { type, ...rest } = event;
      const entry = { kind: type, id: nextId(type), ...rest } as TimelineEntry;
      const next = push(view, entry);
      return event.type === "payment" ? { ...next, spentCents: event.spentCents } : next;
    }
    case "dispute-filed": {
      const { type: _type, ...rest } = event;
      return push(view, { kind: "dispute", id: nextId("dispute"), ...rest, outcome: null });
    }
    case "dispute-outcome": {
      const { type: _type, toolCallId, receiptId, url: _url, ...outcome } = event;
      const entries = view.entries.map((entry) =>
        entry.kind === "dispute" && entry.toolCallId === toolCallId && entry.receiptId === receiptId
          ? { ...entry, outcome }
          : entry,
      );
      return { ...view, entries, spentCents: event.spentCents };
    }
    case "wire": {
      if (!event.toolCallId) return view;
      const trace: WireTrace = { ...(view.wire[event.toolCallId] ?? { url: event.url }) };
      if (event.step.stage === "payment-required") trace.required = event.step;
      else if (event.step.stage === "payment-signature") trace.signature = event.step;
      else trace.response = event.step;
      return { ...view, wire: { ...view.wire, [event.toolCallId]: trace } };
    }
    case "answer":
      return {
        ...view,
        answer: {
          answer: event.answer,
          citations: event.citations,
          manifest: event.manifest ?? null,
        },
        spentCents: event.spentCents,
      };
    case "error":
      return { ...view, error: { code: event.code, message: event.message } };
    case "done":
      return {
        ...view,
        status: event.status,
        spentCents: event.spentCents,
        toolCalls: event.toolCalls,
        noteOpen: false,
      };
  }
}

/** Timeline entries that have an x402 trace worth inspecting. */
export function isInspectable(
  entry: TimelineEntry,
): entry is Extract<TimelineEntry, { kind: "offer" | "payment" | "refusal" }> {
  return entry.kind === "offer" || entry.kind === "payment" || entry.kind === "refusal";
}

/** Splits an SSE buffer into complete events and the unfinished rest. */
export function parseSse(buffer: string): { events: ResearchEvent[]; rest: string } {
  const blocks = buffer.split(/\r?\n\r?\n/);
  const rest = blocks.pop() ?? "";
  const events: ResearchEvent[] = [];
  for (const block of blocks) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    try {
      events.push(JSON.parse(data) as ResearchEvent);
    } catch {
      // A malformed event is skipped; the stream continues.
    }
  }
  return { events, rest };
}
