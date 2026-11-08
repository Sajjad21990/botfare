import { handleDeclineNote } from "../../../../lib/server/fare-advisor-signals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** An agent's optional note on why it did not buy an offer; signed with the agent key. */
export function POST(request: Request): Promise<Response> {
  return handleDeclineNote(request);
}
