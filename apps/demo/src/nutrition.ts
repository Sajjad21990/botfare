/**
 * GET /api/nutrition?recipe=<slug>: per-serving nutrition for each recipe on the site. The figures
 * are our own estimates from the ingredient lists (standard food-composition values, rounded), so
 * they are a guide, not a lab result.
 */
import { z } from "zod";

export interface PerServing {
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
}

export interface Nutrition {
  recipe: string;
  servings: number;
  perServing: PerServing;
}

/** Keyed by recipe slug. `servings` matches the recipe's "Serves N" where it has one. */
export const NUTRITION: Readonly<Record<string, Omit<Nutrition, "recipe">>> = {
  // 250 g red lentils, onion, tomato, 1 tbsp oil and a 2 tbsp ghee tadka; the dal only, no rice.
  "weeknight-red-lentil-dal": {
    servings: 4,
    perServing: { kcal: 345, proteinG: 16, carbsG: 46, fatG: 12 },
  },
  // 1.2 kg peeled potatoes; about half of the 80 ml of fat ends up on them.
  "crispy-oven-potatoes": {
    servings: 4,
    perServing: { kcal: 310, proteinG: 6, carbsG: 51, fatG: 9 },
  },
  // 2 thighs with skin, a quarter of 300 g rice, stock and onion; most rendered fat poured off.
  "one-pan-lemon-chicken-rice": {
    servings: 4,
    perServing: { kcal: 750, proteinG: 42, carbsG: 66, fatG: 34 },
  },
  // 150 g of starter after a feed, in 50 g servings (25 g flour and 25 g water each).
  "sourdough-starter": {
    servings: 3,
    perServing: { kcal: 88, proteinG: 3.2, carbsG: 18, fatG: 0.5 },
  },
};

export const NUTRITION_RECIPES = Object.keys(NUTRITION);

export const nutritionQuerySchema = z.object({
  recipe: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9-]{1,80}$/),
});

/** The recipe's nutrition, or undefined for a slug we have no figures for. */
export function nutritionFor(recipe: string): Nutrition | undefined {
  if (!Object.hasOwn(NUTRITION, recipe)) return undefined;
  const entry = NUTRITION[recipe] as Omit<Nutrition, "recipe">;
  return { recipe, servings: entry.servings, perServing: { ...entry.perServing } };
}
