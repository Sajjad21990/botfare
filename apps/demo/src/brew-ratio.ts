/** The maths behind GET /api/brew-ratio: Crema Notes' house recipes, scaled to a dose. */
import { z } from "zod";

export const BREW_METHODS = {
  v60: {
    name: "Cone pour-over",
    ratio: 16,
    grind: "medium-fine (like table salt)",
    brewTime: "2:45 to 3:15",
    brewSeconds: { min: 165, max: 195 },
    temperatureC: 94,
    note: "Bloom with about twice the coffee's weight in water for 40 s, then pour in slow circles.",
  },
  espresso: {
    name: "Espresso",
    ratio: 2,
    grind: "fine (like powdered sugar, slightly gritty)",
    brewTime: "26 to 32 s",
    brewSeconds: { min: 26, max: 32 },
    temperatureC: 93,
    note: "waterGrams is the espresso yield in the cup, not the water through the machine.",
  },
  "french-press": {
    name: "French press",
    ratio: 15,
    grind: "coarse (like sea salt)",
    brewTime: "4:00 steep, then 1:00 settle",
    brewSeconds: { min: 300, max: 300 },
    temperatureC: 95,
    note: "Stir at 1:00, skim the crust at 4:00, wait a minute and pour without plunging hard.",
  },
} as const;

export type BrewMethod = keyof typeof BREW_METHODS;

export const brewRatioQuerySchema = z.object({
  method: z.enum(Object.keys(BREW_METHODS) as [BrewMethod, ...BrewMethod[]]),
  coffeeGrams: z.coerce.number().min(1).max(250),
});

export interface BrewRatio {
  method: BrewMethod;
  name: string;
  coffeeGrams: number;
  waterGrams: number;
  ratio: string;
  grind: string;
  brewTime: string;
  brewSeconds: { min: number; max: number };
  temperatureC: number;
  note: string;
}

/** Water (or espresso yield) for a dose, rounded to the gram; the dose to 0.1 g. */
export function brewRatio(method: BrewMethod, coffeeGrams: number): BrewRatio {
  const recipe = BREW_METHODS[method];
  const dose = Math.round(coffeeGrams * 10) / 10;
  return {
    method,
    name: recipe.name,
    coffeeGrams: dose,
    waterGrams: Math.round(dose * recipe.ratio),
    ratio: `1:${recipe.ratio}`,
    grind: recipe.grind,
    brewTime: recipe.brewTime,
    brewSeconds: { ...recipe.brewSeconds },
    temperatureC: recipe.temperatureC,
    note: recipe.note,
  };
}
