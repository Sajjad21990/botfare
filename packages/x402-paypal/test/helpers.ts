import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  generateAgentKeyPair,
  InMemoryLedger,
  PrepaidPayPalClient,
  PrepaidPayPalFacilitator,
} from "../src";

export const requirements: PaymentRequirements = {
  scheme: "prepaid",
  network: "paypal:sandbox",
  asset: "USD",
  amount: "3",
  payTo: "site_demo",
  maxTimeoutSeconds: 60,
  extra: {},
};

export async function setup(
  options: {
    balanceCents?: number;
    perRequestMaxCents?: number;
    dailyCapCents?: number;
    allowedPayTo?: string[];
  } = {},
) {
  const ledger = new InMemoryLedger();
  const keys = await generateAgentKeyPair();
  ledger.addKey({
    keyId: "ak_test",
    publicJwk: keys.publicJwk,
    walletId: "owner",
    perRequestMaxCents: options.perRequestMaxCents,
    dailyCapCents: options.dailyCapCents,
    allowedPayTo: options.allowedPayTo,
  });
  ledger.topUp("owner", options.balanceCents ?? 100);
  const client = new PrepaidPayPalClient({ keyId: "ak_test", privateJwk: keys.privateJwk });
  const facilitator = new PrepaidPayPalFacilitator({ ledger });

  async function pay(req: PaymentRequirements = requirements): Promise<PaymentPayload> {
    const result = await client.createPaymentPayload(2, req);
    return {
      x402Version: 2,
      resource: { url: "https://demo.example/articles/burr-basics" },
      accepted: req,
      payload: result.payload,
    };
  }

  return { ledger, keys, client, facilitator, pay };
}
