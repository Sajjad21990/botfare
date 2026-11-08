import { parseSiteAuthHeader } from "@botfare/contracts";
import { authenticateSite, type Site } from "@botfare/core";
import { getDb } from "./db";
import { jsonError } from "./http";

/** The publisher site behind `Authorization: Basic base64(siteId:siteSecret)`, or null. */
export async function authenticateSiteRequest(request: Request): Promise<Site | null> {
  const credentials = parseSiteAuthHeader(request.headers.get("authorization"));
  if (!credentials) return null;
  return authenticateSite(getDb(), credentials.siteId, credentials.siteSecret);
}

export function unauthorized(): Response {
  return jsonError(401, "unauthorized", "Site authentication failed", {
    "WWW-Authenticate": 'Basic realm="BotFare"',
  });
}
