// zod schemas for the PayPal responses we read. Loose objects: unknown fields pass through,
// and only the fields the client actually uses are declared.
import { z } from "zod";

const money = z.looseObject({
  currency_code: z.string(),
  value: z.string(),
});

const link = z.looseObject({
  href: z.string(),
  rel: z.string(),
});

export const tokenResponse = z.looseObject({
  access_token: z.string().min(1),
  expires_in: z.number(),
});

export const createOrderResponse = z.looseObject({
  id: z.string(),
  status: z.string(),
  links: z.array(link).default([]),
});

const capture = z.looseObject({
  id: z.string(),
  status: z.string(),
  amount: money.optional(),
  seller_receivable_breakdown: z
    .looseObject({
      gross_amount: money,
      paypal_fee: money.optional(),
      net_amount: money.optional(),
    })
    .optional(),
});

export const captureOrderResponse = z.looseObject({
  id: z.string(),
  status: z.string(),
  payer: z
    .looseObject({
      email_address: z.string().optional(),
      payer_id: z.string().optional(),
    })
    .optional(),
  payment_source: z
    .looseObject({
      paypal: z
        .looseObject({
          email_address: z.string().optional(),
          account_id: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  purchase_units: z
    .array(
      z.looseObject({
        payments: z.looseObject({ captures: z.array(capture).default([]) }).optional(),
      }),
    )
    .default([]),
});

export const refundResponse = z.looseObject({
  id: z.string(),
  status: z.string(),
});

const batchHeader = z.looseObject({
  payout_batch_id: z.string(),
  batch_status: z.string(),
});

export const createPayoutResponse = z.looseObject({
  batch_header: batchHeader,
});

export const getPayoutResponse = z.looseObject({
  batch_header: batchHeader,
  items: z
    .array(
      z.looseObject({
        payout_item_id: z.string(),
        transaction_status: z.string().default("PENDING"),
        payout_item: z.looseObject({
          amount: z.looseObject({ currency: z.string(), value: z.string() }),
          receiver: z.string().optional(),
          sender_item_id: z.string().optional(),
        }),
        errors: z
          .looseObject({
            name: z.string().default("UNKNOWN"),
            message: z.string().default(""),
          })
          .optional(),
      }),
    )
    .default([]),
});

export const verifyWebhookResponse = z.looseObject({
  verification_status: z.string(),
});
