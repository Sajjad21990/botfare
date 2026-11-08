import type {
  AssetAmount,
  Network,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  SupportedKind,
} from "@x402/core/types";
import { MAX_AUTHORIZATION_SECONDS, PREPAID_SCHEME, USD } from "./constants";
import { moneyToCents } from "./money";

/** Resource-server side of the plug-in: turns "$0.03" into requirements for the prepaid scheme. */
export class PrepaidPayPalServer implements SchemeNetworkServer {
  readonly scheme = PREPAID_SCHEME;
  /** No on-wire asset transfer method; "default" is SDK plumbing. */
  readonly defaultAssetTransferMethod = "default";
  /** Verify before the handler, settle after it: agents are never charged for a failed response. */
  readonly paymentFlows = {
    default: { supported: ["authorization"] as const, default: "authorization" as const },
  };

  async parsePrice(price: Price, _network: Network): Promise<AssetAmount> {
    if (typeof price === "object") {
      if (price.asset !== USD.asset) throw new Error(`Unsupported asset ${price.asset}`);
      return price;
    }
    return { asset: USD.asset, amount: String(moneyToCents(price)) };
  }

  getAssetDecimals(asset: string, _network: Network): number | undefined {
    return asset === USD.asset ? USD.decimals : undefined;
  }

  async enhancePaymentRequirements(
    requirements: PaymentRequirements,
    _supportedKind: SupportedKind,
    _facilitatorExtensions: string[],
  ): Promise<PaymentRequirements> {
    return {
      ...requirements,
      maxTimeoutSeconds: Math.min(requirements.maxTimeoutSeconds, MAX_AUTHORIZATION_SECONDS),
    };
  }
}
