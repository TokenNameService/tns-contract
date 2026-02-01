import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { Keypair } from "@solana/web3.js";
import { expect } from "chai";
import { createMint } from "@solana/spl-token";
import {
  setupTest,
  TestContext,
  ensureConfigInitialized,
  fundAccounts,
  getTokenPda,
  getBalance,
  refreshConfigState,
  ensureUnpaused,
} from "./helpers/setup";

// Max slippage for tests (1 SOL)
const MAX_SOL_COST = new BN(1_000_000_000);

describe("TNS - Update Mint", () => {
  let ctx: TestContext;
  const testSymbol = "UPDMINT";
  let tokenPda: anchor.web3.PublicKey;
  let testTokenMint: anchor.web3.PublicKey;
  let newMintForUpdate: anchor.web3.PublicKey;

  before(async () => {
    ctx = setupTest();
    await ensureConfigInitialized(ctx);
    await fundAccounts(ctx.provider, ctx.registrant, ctx.feeCollector);

    // Refresh config to get current state
    await refreshConfigState(ctx);

    // Ensure protocol is unpaused (test isolation)
    await ensureUnpaused(ctx);

    // Create a test token mint
    testTokenMint = await createMint(
      ctx.provider.connection,
      ctx.admin.payer,
      ctx.admin.publicKey,
      null,
      9
    );

    // Create a second mint for update tests
    newMintForUpdate = await createMint(
      ctx.provider.connection,
      ctx.admin.payer,
      ctx.admin.publicKey,
      null,
      9
    );

    // Register a symbol to update (as admin for Phase 1)
    tokenPda = getTokenPda(ctx.program.programId, testSymbol);

    await ctx.program.methods
      .registerSymbolSol(testSymbol, 1, MAX_SOL_COST, 0)
      .accountsPartial({
        payer: ctx.admin.publicKey,
        config: ctx.configPda,
        tokenAccount: tokenPda,
        tokenMint: testTokenMint,
        feeCollector: ctx.feeCollectorPubkey,
        solUsdPriceFeed: ctx.solUsdPythFeed,
        platformFeeAccount: null,
      })
      .rpc();
  });

  it("owner can update mint", async () => {
    const { program, admin, configPda, feeCollectorPubkey, solUsdPythFeed } =
      ctx;

    const feeCollectorBalanceBefore = await getBalance(
      ctx.provider,
      feeCollectorPubkey
    );

    await program.methods
      .updateMintSol(MAX_SOL_COST, 0)
      .accountsPartial({
        owner: admin.publicKey,
        config: configPda,
        tokenAccount: tokenPda,
        feeCollector: feeCollectorPubkey,
        solUsdPriceFeed: solUsdPythFeed,
        platformFeeAccount: null,
        newMint: newMintForUpdate,
      })
      .rpc();

    const tokenAccount = await program.account.token.fetch(tokenPda);

    expect(tokenAccount.mint.toString()).to.equal(newMintForUpdate.toString());

    // Verify fee was paid
    const feeCollectorBalanceAfter = await getBalance(
      ctx.provider,
      feeCollectorPubkey
    );
    expect(feeCollectorBalanceAfter).to.be.greaterThan(
      feeCollectorBalanceBefore
    );
  });

  it("fails if non-owner tries to update mint", async () => {
    const {
      program,
      registrant,
      configPda,
      feeCollectorPubkey,
      solUsdPythFeed,
    } = ctx;

    // Use testTokenMint as a valid mint to update to
    try {
      await program.methods
        .updateMintSol(MAX_SOL_COST, 0)
        .accountsPartial({
          owner: registrant.publicKey, // Registrant is not the owner
          config: configPda,
          tokenAccount: tokenPda,
          feeCollector: feeCollectorPubkey,
          solUsdPriceFeed: solUsdPythFeed,
          platformFeeAccount: null,
          newMint: testTokenMint, // Valid mint, but wrong owner
        })
        .signers([registrant])
        .rpc();

      expect.fail("Should have thrown an error");
    } catch (err) {
      expect(err.message).to.include("Unauthorized");
    }
  });

  it("fails if updating to same mint", async () => {
    const { program, admin, configPda, feeCollectorPubkey, solUsdPythFeed } =
      ctx;

    // Get current mint
    const tokenAccount = await program.account.token.fetch(tokenPda);
    const currentMint = tokenAccount.mint;

    try {
      await program.methods
        .updateMintSol(MAX_SOL_COST, 0)
        .accountsPartial({
          owner: admin.publicKey,
          config: configPda,
          feeCollector: feeCollectorPubkey,
          solUsdPriceFeed: solUsdPythFeed,
          tokenAccount: tokenPda,
          platformFeeAccount: null,
          newMint: currentMint,
        })
        .rpc();

      expect.fail("Should have thrown an error");
    } catch (err) {
      expect(err.message).to.include("SameMint");
    }
  });
});
