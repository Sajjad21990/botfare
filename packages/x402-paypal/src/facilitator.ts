import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { z } from "zod";
import {
  authorizationLifetime,
  ErrorReason,
  isPayPalNetwork,
  PAYPAL_FAMILY,
  PREPAID_SCHEME,
  USD,
} from "./constants";
import { readKeyId, verifyAuthorization } from "./jws";
import type { ChargeRequest, PrepaidLedgerPort } from "./ledger-port";
import { parseAtomicCents } from "./money";

const prepaidPayloadSchema = z.object({ authorization: z.string().min(1) });

export interface PrepaidFacilitatorOptions {
  ledger: PrepaidLedgerPort;
  now?: () => Date;
}

type Checked = { ok: true; request: ChargeRequest } | { ok: false; response: VerifyResponse };

/** Facilitator side of the plug-in: checks the agent's signature and hands money to the ledger. */
export class PrepaidPayPalFacilitator implements SchemeNetworkFacilitator {
  readonly scheme = PREPAID_SCHEME;
  readonly caipFamily = PAYPAL_FAMILY;
  private readonly ledger: PrepaidLedgerPort;
  private readonly now: () => Date;

  constructor(options: PrepaidFacilitatorOptions) {
    this.ledger = options.ledger;
    this.now = options.now ?? (() => new Date());
  }

  getExtra(_network: Network): Record<string, unknown> | undefined {
    return undefined;
  }

  getSigners(_network: string): string[] {
    return [];
  }

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const checked = await this.checkAuthorization(payload, requirements);
    if (!checked.ok) return checked.response;
    const decision = await this.ledger.check(checked.request);
    if (!decision.ok) {
      const response = invalid(decision.reason, decision.message, checked.request.keyId);
      return decision.originalTransaction
        ? { ...response, extra: { originalTransaction: decision.originalTransaction } }
        : response;
    }
    return { isValid: true, payer: checked.request.keyId };
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const failed = (
      reason: string,
      message?: string,
      payer?: string,
      originalTransaction?: string,
    ): SettleResponse => ({
      success: false,
      errorReason: reason,
      errorMessage: message,
      payer,
      transaction: "",
      network: requirements.network,
      // A reused nonce points at the receipt it was first charged under, so a settle whose
      // response was lost can be reconciled instead of looking like a charge with no record.
      ...(originalTransaction ? { extra: { originalTransaction } } : {}),
    });

    const checked = await this.checkAuthorization(payload, requirements);
    if (!checked.ok) {
      const { invalidReason, invalidMessage, payer } = checked.response;
      return failed(invalidReason ?? ErrorReason.InvalidPayload, invalidMessage, payer);
    }
    const { request } = checked;
    try {
      const result = await this.ledger.charge(request);
      if (!result.ok) {
        return failed(result.reason, result.message, request.keyId, result.originalTransaction);
      }
      return {
        success: true,
        payer: request.keyId,
        transaction: result.transaction,
        network: requirements.network,
        amount: requirements.amount,
        ...(result.extra ? { extra: result.extra } : {}),
      };
    } catch (err) {
      return failed(ErrorReason.UnexpectedSettleError, (err as Error).message, request.keyId);
    }
  }

  /** Stateless checks shared by verify and settle: shape, signature, expiry, and field binding. */
  private async checkAuthorization(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<Checked> {
    const fail = (reason: string, message: string, payer?: string): Checked => ({
      ok: false,
      response: invalid(reason, message, payer),
    });

    if (requirements.scheme !== PREPAID_SCHEME) {
      return fail(
        ErrorReason.InvalidScheme,
        `Scheme ${requirements.scheme} is not ${PREPAID_SCHEME}`,
      );
    }
    if (!isPayPalNetwork(requirements.network)) {
      return fail(
        ErrorReason.InvalidNetwork,
        `Network ${requirements.network} is not a PayPal network`,
      );
    }
    if (requirements.asset !== USD.asset) {
      return fail(ErrorReason.InvalidRequirements, `Asset ${requirements.asset} is not USD`);
    }
    let amountCents: number;
    try {
      amountCents = parseAtomicCents(requirements.amount);
    } catch (err) {
      return fail(ErrorReason.InvalidRequirements, (err as Error).message);
    }

    const parsed = prepaidPayloadSchema.safeParse(payload.payload);
    if (!parsed.success) {
      return fail(ErrorReason.InvalidPayload, "payload.authorization must be a signed JWS");
    }
    const token = parsed.data.authorization;
    const keyId = readKeyId(token);
    if (!keyId) return fail(ErrorReason.InvalidPayload, "Authorization has no key ID");

    const key = await this.ledger.getAgentKey(keyId);
    if (!key) return fail(ErrorReason.UnknownKey, `Unknown agent key ${keyId}`, keyId);
    if (key.status !== "active") return fail(ErrorReason.KeyRevoked, "Agent key is revoked", keyId);

    const verified = await verifyAuthorization(token, key.publicJwk, this.now());
    if (!verified.ok) {
      if (verified.error === "expired") {
        return fail(ErrorReason.Expired, "Authorization has expired", keyId);
      }
      if (verified.error === "bad_time") {
        return fail(ErrorReason.Expired, "Authorization is dated in the future or too old", keyId);
      }
      return fail(ErrorReason.InvalidSignature, "Signature does not verify", keyId);
    }
    const { claims } = verified;

    // The signature must cover exactly what the server is charging, and what the client accepted.
    const accepted = payload.accepted;
    const fields = ["scheme", "network", "asset", "amount", "payTo"] as const;
    for (const field of fields) {
      if (claims[field] !== requirements[field] || accepted?.[field] !== requirements[field]) {
        return fail(ErrorReason.Mismatch, `Signed ${field} does not match the requirements`, keyId);
      }
    }
    const lifetime = authorizationLifetime(requirements.maxTimeoutSeconds);
    if (claims.exp - claims.iat > lifetime) {
      return fail(ErrorReason.Mismatch, `Authorization lives longer than ${lifetime}s`, keyId);
    }

    return {
      ok: true,
      request: {
        keyId,
        nonce: claims.nonce,
        amountCents,
        payTo: requirements.payTo,
        network: requirements.network,
        resourceUrl: payload.resource?.url,
        expiresAt: claims.exp,
        ...(requirements.extra ? { extra: requirements.extra } : {}),
      },
    };
  }
}

function invalid(reason: string, message?: string, payer?: string): VerifyResponse {
  return { isValid: false, invalidReason: reason, invalidMessage: message, payer };
}
