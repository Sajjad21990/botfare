"use client";

import { useSyncExternalStore } from "react";

/**
 * Dashboard-wide live status, shared by the poller and the custom widgets. Custom widgets render
 * inside AG Studio, so they read this small store rather than props from the page.
 */
export interface LiveState {
  /** The publisher's withdrawable earnings balance, from the ledger. */
  earningsUsd: number;
  /** Time of the last successful poll (ms since epoch), or null before the first. */
  lastSyncAt: number | null;
  /** False while polls are failing. */
  online: boolean;
  /** Receipt IDs that arrived since the page loaded, newest first (for the ticker's highlight). */
  freshIds: string[];
}

let state: LiveState = { earningsUsd: 0, lastSyncAt: null, online: true, freshIds: [] };
const listeners = new Set<() => void>();

export function setLiveState(patch: Partial<LiveState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function getLiveState(): LiveState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLiveState(): LiveState {
  return useSyncExternalStore(subscribe, getLiveState, getLiveState);
}

/** Re-renders every `intervalMs` so "updated 3s ago" stays honest. */
export function useNow(intervalMs = 1000): number {
  return useSyncExternalStore(
    (onTick) => {
      const id = setInterval(onTick, intervalMs);
      return () => clearInterval(id);
    },
    () => Math.floor(Date.now() / intervalMs) * intervalMs,
    () => 0,
  );
}

export const usd = (value: number, maxDigits = 2): string =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: maxDigits,
  }).format(value);

export function timeAgo(from: number | null, now: number): string {
  if (from == null) return "connecting";
  const seconds = Math.max(0, Math.round((now - from) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
}
