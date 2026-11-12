"use client";

import { useId } from "react";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** One provider from GET /api/research/models (never a key). */
export interface ProviderOption {
  provider: string;
  label: string;
  models: { id: string; free?: boolean }[];
  default: string;
}

export interface ModelsResponse {
  providers: ProviderOption[];
  default: ModelChoice | null;
}

export interface ModelChoice {
  provider: string;
  model: string;
}

const STORAGE_KEY = "botfare.research.model";

/** GET /api/research/models once; an empty list when it cannot be read. */
export async function fetchModels(): Promise<ModelsResponse> {
  try {
    const response = await fetch("/api/research/models", { cache: "no-store" });
    if (!response.ok) return { providers: [], default: null };
    return (await response.json()) as ModelsResponse;
  } catch {
    return { providers: [], default: null };
  }
}

function isOffered(models: ModelsResponse, choice: ModelChoice | null): choice is ModelChoice {
  return Boolean(
    choice &&
      models.providers.some(
        (p) => p.provider === choice.provider && p.models.some((m) => m.id === choice.model),
      ),
  );
}

/** The last choice this browser made, if the server still offers it; else the server's default. */
export function initialChoice(models: ModelsResponse): ModelChoice | null {
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null") as unknown;
    if (saved && typeof saved === "object") {
      const { provider, model } = saved as Record<string, unknown>;
      const choice =
        typeof provider === "string" && typeof model === "string" ? { provider, model } : null;
      if (isOffered(models, choice)) return choice;
    }
  } catch {
    // Storage blocked or unreadable: use the default.
  }
  if (isOffered(models, models.default)) return models.default;
  const first = models.providers[0];
  return first ? { provider: first.provider, model: first.default } : null;
}

/** The server's default model (AI_PROVIDER and its model), else the first provider's default. */
export function defaultChoice(models: ModelsResponse): ModelChoice | null {
  if (isOffered(models, models.default)) return models.default;
  const first = models.providers[0];
  return first ? { provider: first.provider, model: first.default } : null;
}

export function rememberChoice(choice: ModelChoice): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(choice));
  } catch {
    // Not remembered; nothing else depends on it.
  }
}

interface ModelPickerProps {
  providers: ProviderOption[];
  value: ModelChoice;
  onChange: (choice: ModelChoice) => void;
  disabled: boolean;
}

/** Provider and model for the research agent: the server's default, or any configured provider. */
export function ModelPicker({ providers, value, onChange, disabled }: ModelPickerProps) {
  const id = useId();
  const current = providers.find((p) => p.provider === value.provider) ?? providers[0];
  if (!current) return null;
  const selected = current.models.find((m) => m.id === value.model);
  const providerItems = providers.map((p) => ({ value: p.provider, label: p.label }));
  const modelItems = current.models.map((m) => ({ value: m.id, label: m.id }));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={id}>Model</Label>
        {selected?.free ? <Badge variant="secondary">free</Badge> : null}
      </div>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)]">
        <Select
          value={current.provider}
          items={providerItems}
          disabled={disabled}
          onValueChange={(next) => {
            const provider = providers.find((p) => p.provider === next);
            if (provider) onChange({ provider: provider.provider, model: provider.default });
          }}
        >
          <SelectTrigger id={id} size="sm" className="w-full text-xs" aria-label="AI provider">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {providers.map((p) => (
              <SelectItem key={p.provider} value={p.provider} className="text-xs">
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={selected ? selected.id : current.default}
          items={modelItems}
          disabled={disabled}
          onValueChange={(next) => {
            if (typeof next === "string") onChange({ provider: current.provider, model: next });
          }}
        >
          <SelectTrigger size="sm" className="w-full min-w-0 font-mono text-xs" aria-label="Model">
            <SelectValue className="truncate" />
          </SelectTrigger>
          <SelectContent>
            {current.models.map((m) => (
              <SelectItem key={m.id} value={m.id} className="font-mono text-xs">
                <span className="truncate">{m.id}</span>
                {m.free ? <Badge variant="secondary">free</Badge> : null}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
