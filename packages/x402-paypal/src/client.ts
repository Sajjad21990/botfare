import type {
  DefaultAsset,
  Network,
  PaymentPayloadContext,
  PaymentPayloadResult,
  PaymentRequirements,
  SchemeNetworkClient,
} from "@x402/core/types";
import type { JWK } from "jose";
import { authorizationLifetime, isPayPalNetwork, PREPAID_SCHEME, USD } from "./constants";
import { signAuthorization } from "./jws";

export interface PrepaidClientOptions {
  /** Agent key ID issued by BotFare (the JWS `kid`). */
  keyId: string;
  /** The agent's Ed25519 private key. It never leaves the agent. */
  privateJwk: JWK;
  now?: () => Date;
}

/** Agent side of the plug-in: signs a single-use debit authorization for the accepted requirements. */
export class PrepaidPayPalClient implements SchemeNetworkClient {
  readonly scheme = PREPAID_SCHEME;
  private readonly options: PrepaidClientOptions;

  constructor(options: PrepaidClientOptions) {
    this.options = options;
  }

  /** Lets the SDK's spend controls cap USD payments (e.g. "$0.10" per request). */
  findDefaultAsset = (asset: string, network: Network): DefaultAsset | undefined =>
    asset === USD.asset && isPayPalNetwork(network) ? USD : undefined;

  async createPaymentPayload(
    x402Version: number,
    requirements: PaymentRequirements,
    _context?: PaymentPayloadContext,
  ): Promise<PaymentPayloadResult> {
    if (requirements.scheme !== PREPAID_SCHEME || !isPayPalNetwork(requirements.network)) {
      throw new Error(`Cannot pay ${requirements.scheme} on ${requirements.network}`);
    }
    if (requirements.asset !== USD.asset) {
      throw new Error(`Unsupported asset ${requirements.asset}`);
    }
    const iat = Math.floor((this.options.now?.() ?? new Date()).getTime() / 1000);
    const lifetime = authorizationLifetime(requirements.maxTimeoutSeconds);
    const authorization = await signAuthorization(
      {
        scheme: requirements.scheme,
        network: requirements.network,
        asset: requirements.asset,
        amount: requirements.amount,
        payTo: requirements.payTo,
        // The agent picks the nonce, as in x402's exact scheme; the facilitator makes it single-use.
        nonce: crypto.randomUUID(),
        iat,
        exp: iat + lifetime,
      },
      this.options.keyId,
      this.options.privateJwk,
    );
    return { x402Version, payload: { authorization } };
  }
}
