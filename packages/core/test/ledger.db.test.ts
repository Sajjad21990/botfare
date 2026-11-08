import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  Accounts,
  accountBalanceMicros,
  creditTopUp,
  ledgerTotalMicros,
  postTransaction,
  schema,
  seedWallet,
  walletBalanceMicros,
} from "../src";
import { expectLedgerHealthy, makeUser, openTestDb } from "./helpers";

const { db, close } = openTestDb();
afterEach(() => expectLedgerHealthy(db));
afterAll(close);

describe("postTransaction", () => {
  it("rejects entries that do not sum to zero", async () => {
    const user = await makeUser(db);
    await expect(
      postTransaction(db, {
        kind: "seed",
        idempotencyKey: `unbalanced:${user.id}`,
        entries: [
          { accountId: Accounts.wallet(user.id), amountMicros: 10 },
          { accountId: Accounts.paypalClearing, amountMicros: -9 },
        ],
      }),
    ).rejects.toThrow(/Unbalanced/);
    await expect(
      postTransaction(db, {
        kind: "seed",
        idempotencyKey: `fraction:${user.id}`,
        entries: [
          { accountId: Accounts.wallet(user.id), amountMicros: 0.5 },
          { accountId: Accounts.paypalClearing, amountMicros: -0.5 },
        ],
      }),
    ).rejects.toThrow(/integer/);
    expect(await walletBalanceMicros(db, user.id)).toBe(0);
  });

  it("is idempotent by key and creates accounts on first use", async () => {
    const user = await makeUser(db);
    const input = {
      kind: "seed" as const,
      idempotencyKey: `idem:${user.id}`,
      entries: [
        { accountId: Accounts.wallet(user.id), amountMicros: 250_000 },
        { accountId: Accounts.paypalClearing, amountMicros: -250_000 },
      ],
    };
    const first = await postTransaction(db, input);
    const second = await postTransaction(db, input);
    expect(first.created).toBe(true);
    expect(second).toEqual({ transactionId: first.transactionId, created: false });
    expect(await walletBalanceMicros(db, user.id)).toBe(250_000);
    const [account] = await db
      .select()
      .from(schema.ledgerAccounts)
      .where(eq(schema.ledgerAccounts.id, Accounts.wallet(user.id)));
    expect(account).toMatchObject({ kind: "wallet", ownerUserId: user.id });
  });

  it("never lets a wallet go negative", async () => {
    const user = await makeUser(db);
    await seedWallet(db, { ownerUserId: user.id, cents: 1, idempotencyKey: `neg:${user.id}` });
    await expect(
      postTransaction(db, {
        kind: "charge",
        idempotencyKey: `overdraw:${user.id}`,
        entries: [
          { accountId: Accounts.wallet(user.id), amountMicros: -10_001 },
          { accountId: Accounts.platformFees, amountMicros: 10_001 },
        ],
      }),
    ).rejects.toThrow();
    expect(await walletBalanceMicros(db, user.id)).toBe(10_000);
  });
});

describe("creditTopUp", () => {
  it("credits a capture once and books the PayPal fee against BotFare", async () => {
    const user = await makeUser(db);
    const captureId = `CAP-${user.id}`;
    const feesBefore = await accountBalanceMicros(db, Accounts.platformFees);
    const paypalFeesBefore = await accountBalanceMicros(db, Accounts.paypalFees);
    const input = {
      ownerUserId: user.id,
      orderId: `ORDER-${user.id}`,
      captureId,
      grossCents: 500,
      feeCents: 66,
    };

    const [first, again] = await Promise.all([creditTopUp(db, input), creditTopUp(db, input)]);
    const third = await creditTopUp(db, input);

    expect([first.created, again.created].sort()).toEqual([false, true]);
    expect(third.created).toBe(false);
    expect(new Set([first.transactionId, again.transactionId, third.transactionId]).size).toBe(1);
    expect(third.topup).toMatchObject({ captureId, grossCents: 500, feeCents: 66 });
    expect(await walletBalanceMicros(db, user.id)).toBe(5_000_000);
    expect((await accountBalanceMicros(db, Accounts.platformFees)) - feesBefore).toBe(-660_000);
    expect((await accountBalanceMicros(db, Accounts.paypalFees)) - paypalFeesBefore).toBe(660_000);
    const rows = await db
      .select()
      .from(schema.topups)
      .where(eq(schema.topups.captureId, captureId));
    expect(rows).toHaveLength(1);
  });

  it("seeds demo wallets once per key", async () => {
    const user = await makeUser(db);
    const input = { ownerUserId: user.id, cents: 200, idempotencyKey: `judge:${user.id}` };
    await seedWallet(db, input);
    await seedWallet(db, input);
    expect(await walletBalanceMicros(db, user.id)).toBe(2_000_000);
    expect(await ledgerTotalMicros(db)).toBe(0);
  });
});
