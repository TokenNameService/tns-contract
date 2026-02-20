import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { Keypair, PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import {
  setupTest,
  TestContext,
  ensureConfigInitialized,
  fundAccounts,
  getTokenPda,
  getBalance,
  refreshConfigState,
  ensureUnpaused,
  createTokenWithMetadata,
  getMetadataPda,
} from "./helpers/setup";

// Max slippage for tests (1 SOL)
const MAX_SOL_COST = new BN(1_000_000_000);

describe("TNS - Update Mint", () => {
  let ctx: TestContext;
  const testSymbol = "UPDMINT";
  let tokenPda: anchor.web3.PublicKey;
  let testTokenMint: anchor.web3.PublicKey;
  let testTokenMetadata: anchor.web3.PublicKey;
  let newMintForUpdate: anchor.web3.PublicKey;
  let newMintMetadata: anchor.web3.PublicKey;

  before(async () => {
    ctx = setupTest();
    await ensureConfigInitialized(ctx);
    await fundAccounts(ctx.provider, ctx.registrant, ctx.feeCollector);

    // Refresh config to get current state
    await refreshConfigState(ctx);

    // Ensure protocol is unpaused (test isolation)
    await ensureUnpaused(ctx);

    // Create a test token mint with metadata
    testTokenMint = await createTokenWithMetadata(
      ctx.provider,
      ctx.admin,
      testSymbol,
      `${testSymbol} Token`,
      true // immutable
    );
    testTokenMetadata = getMetadataPda(testTokenMint);

    // Create a second mint for update tests (same symbol since it needs to match)
    newMintForUpdate = await createTokenWithMetadata(
      ctx.provider,
      ctx.admin,
      testSymbol, // Same symbol for valid update
      `${testSymbol} Token V2`,
      true // immutable
    );
    newMintMetadata = getMetadataPda(newMintForUpdate);

    // Register a symbol to update (as admin for Phase 1)
    tokenPda = getTokenPda(ctx.program.programId, testSymbol);

    await ctx.program.methods
      .registerSymbolSol(testSymbol, 1, MAX_SOL_COST, 0)
      .accountsPartial({
        payer: ctx.admin.publicKey,
        config: ctx.configPda,
        tokenAccount: tokenPda,
        tokenMint: testTokenMint,
        tokenMetadata: testTokenMetadata,
        feeCollector: ctx.feeCollectorPubkey,
        priceUpdate: ctx.priceUpdate,
        platformFeeAccount: null,
      })
      .rpc();
  });

  it("owner can update mint", async () => {
    const { program, admin, configPda, feeCollectorPubkey, priceUpdate } =
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
        priceUpdate: priceUpdate,
        platformFeeAccount: null,
        newMint: newMintForUpdate,
        newMintMetadata: newMintMetadata,
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
      priceUpdate,
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
          priceUpdate: priceUpdate,
          platformFeeAccount: null,
          newMint: testTokenMint, // Valid mint, but wrong owner
          newMintMetadata: testTokenMetadata,
        })
        .signers([registrant])
        .rpc();

      expect.fail("Should have thrown an error");
    } catch (err) {
      expect(err.message).to.include("Unauthorized");
    }
  });

  it("fails if updating to same mint", async () => {
    const { program, admin, configPda, feeCollectorPubkey, priceUpdate } =
      ctx;

    // Get current mint
    const tokenAccount = await program.account.token.fetch(tokenPda);
    const currentMint = tokenAccount.mint;
    // Current mint is newMintForUpdate after first test
    const currentMintMetadata = getMetadataPda(currentMint);

    try {
      await program.methods
        .updateMintSol(MAX_SOL_COST, 0)
        .accountsPartial({
          owner: admin.publicKey,
          config: configPda,
          feeCollector: feeCollectorPubkey,
          priceUpdate: priceUpdate,
          tokenAccount: tokenPda,
          platformFeeAccount: null,
          newMint: currentMint,
          newMintMetadata: currentMintMetadata,
        })
        .rpc();

      expect.fail("Should have thrown an error");
    } catch (err) {
      expect(err.message).to.include("SameMint");
    }
  });
});
