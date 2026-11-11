/** Where the landing page sends people for the code and the deep technical write-up. */
export const REPO_URL = "https://github.com/Sajjad21990/botfare";

/** The README on GitHub; pass a heading anchor (e.g. "trust-and-cryptography") to jump to it. */
export function readmeUrl(anchor = "readme"): string {
  return `${REPO_URL}#${anchor}`;
}

export const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;

export const MCP_README_URL = `${REPO_URL}/tree/main/packages/mcp#readme`;

/** The dal recipe on the live Saffron & Salt demo site: free in a browser, 2¢ for an AI agent. */
export const DEMO_RECIPE_URL = "https://botfare-demo.onrender.com/recipes/weeknight-red-lentil-dal";

/** Spread on a link that opens in a new tab. Pair it with NEW_TAB_HINT (or use NewTabLink). */
export const NEW_TAB = { target: "_blank", rel: "noopener noreferrer" } as const;

/** Visually hidden text that tells screen reader users a link opens a new tab. */
export const NEW_TAB_HINT = " (opens in a new tab)";
