import { handleCitationReport } from "../../../lib/server/fare-advisor-signals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Which paid reads an agent's answer cited; signed with the agent key. */
export function POST(request: Request): Promise<Response> {
  return handleCitationReport(request);
}
