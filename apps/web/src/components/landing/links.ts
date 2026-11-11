/** Where the landing page sends people for the code and the deep technical write-up. */
export const REPO_URL = "https://github.com/Sajjad21990/botfare";

/** The README on GitHub; pass a heading anchor (e.g. "trust-and-cryptography") to jump to it. */
export function readmeUrl(anchor = "readme"): string {
  return `${REPO_URL}#${anchor}`;
}

export const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;

export const MCP_README_URL = `${REPO_URL}/tree/main/packages/mcp#readme`;
