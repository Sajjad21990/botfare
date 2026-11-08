import { ErrorReason, PAYPAL_SANDBOX, PREPAID_SCHEME } from "@botfare/x402-paypal";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { z } from "zod";
import { authenticateSiteRequest, unauthorized } from "./auth";
import { getFacilitator } from "./facilitator";
import { jsonError, readJson } from "./http";

/** x402 V2 payment requirements, as the resource server sends them. Unknown keys are kept. */
const requirementsSchema = z
  .object({
    scheme: z.string().min(1),
    network: z.string().min(1),
    amount: z.string().min(1),
    asset: z.string().min(1),
    payTo: z.string().min(1),
    maxTimeoutSeconds: z.number(),
    extra: z.record(z.string(), z.unknown()).nullish(),
  })
  .loose();

const payloadSchema = z
  .object({
    x402Version: z.number().int(),
    resource: z.object({ url: z.string() }).loose().nullish(),
    accepted: requirementsSchema,
    payload: z.record(z.string(), z.unknown()),
    extensions: z.record(z.string(), z.unknown()).nullish(),
  })
  .loose();

/** Body of POST /api/x402/verify and /settle (sent by the SDK's HTTPFacilitatorClient). */
export const facilitatorRequestSchema = z.object({
  x402Version: z.number().int(),
  paymentPayload: payloadSchema,
  paymentRequirements: requirementsSchema,
});

type Operation = "verify" | "settle";

/** Why a request is refused before it reaches the facilitator, as an x402 reason. */
function precheck(
  siteId: string,
  requirements: PaymentRequirements,
): { reason: string; message: string } | null {
  if (requirements.payTo !== siteId) {
    return {
      reason: ErrorReason.SiteNotAllowed,
      message: `Site ${siteId} cannot collect payments for ${requirements.payTo}`,
    };
  }
  if (requirements.scheme !== PREPAID_SCHEME) {
    return {
      reason: ErrorReason.InvalidScheme,
      message: `Unsupported scheme ${requirements.scheme}`,
    };
  }
  if (requirements.network !== PAYPAL_SANDBOX) {
    return {
      reason: ErrorReason.InvalidNetwork,
      message: `Unsupported network ${requirements.network}`,
    };
  }
  return null;
}

/**
 * Shared handler for verify and settle: site auth (401), body shape (400), then the site must be
 * the payee. A refusal after authentication is an HTTP 200 x402 failure, so the SDK on the
 * publisher's side reports it as a normal invalid payment rather than a transport error.
 */
export async function handleFacilitatorCall(
  request: Request,
  operation: Operation,
): Promise<Response> {
  const site = await authenticateSiteRequest(request);
  if (!site) return unauthorized();

  const body = await readJson(request, facilitatorRequestSchema);
  if (!body.ok) return body.response;
  const paymentPayload = body.data.paymentPayload as PaymentPayload;
  const requirements = body.data.paymentRequirements as PaymentRequirements;

  const refused = precheck(site.id, requirements);
  if (refused) {
    if (operation === "verify") {
      const response: VerifyResponse = {
        isValid: false,
        invalidReason: refused.reason,
        invalidMessage: refused.message,
      };
      return Response.json(response);
    }
    const response: SettleResponse = {
      success: false,
      errorReason: refused.reason,
      errorMessage: refused.message,
      transaction: "",
      network: requirements.network,
    };
    return Response.json(response);
  }

  try {
    const facilitator = getFacilitator();
    const result =
      operation === "verify"
        ? await facilitator.verify(paymentPayload, requirements)
        : await facilitator.settle(paymentPayload, requirements);
    logResult(site.id, operation, result);
    return Response.json(result);
  } catch (err) {
    console.error(`[x402] ${operation} failed for ${site.id}:`, (err as Error).message);
    return jsonError(500, `${operation}_failed`, "The facilitator could not process the payment");
  }
}

function logResult(siteId: string, operation: Operation, result: VerifyResponse | SettleResponse) {
  if ("isValid" in result) {
    console.info(
      `[x402] verify ${siteId} payer=${result.payer ?? "-"} ${result.isValid ? "valid" : result.invalidReason}`,
    );
  } else {
    console.info(
      `[x402] ${operation} ${siteId} payer=${result.payer ?? "-"} ${result.success ? result.transaction : result.errorReason}`,
    );
  }
}
