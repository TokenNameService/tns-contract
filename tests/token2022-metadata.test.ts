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
  refreshConfigState,
  ensureUnpaused,
  createTokenWithMetadata,
  createToken2022WithMetadata,
  getMetadataPda,
  TOKEN_2022_PROGRAM_ID,
} from "./helpers/setup";

// Max slippage for tests (1 SOL)
const MAX_SOL_COST = new BN(1_000_000_000);

describe("TNS - Token-2022 Metadata Support", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = setupTest();
    await ensureConfigInitialized(ctx);
    await fundAccounts(ctx.provider, ctx.registrant, ctx.feeCollector);
    await refreshConfigState(ctx);
    await ensureUnpaused(ctx);
  });

  describe("Token-2022 mints (pump.fun style)", () => {
    it("registers Token-2022 mint when passing mint as metadata", async () => {
      const { program, admin, configPda, feeCollectorPubkey, solUsdPythFeed } = ctx;
      const symbol = "T22OK";
      const tokenPda = getTokenPda(program.programId, symbol);

      // Create Token-2022 mint with embedded metadata
      const tokenMint = await createToken2022WithMetadata(
        ctx.provider,
        ctx.admin,
        symbol,
        `${symbol} Token`
      );

      // Verify it's a Token-2022 mint
      const mintAccountInfo = await ctx.provider.connection.getAccountInfo(tokenMint);
      expect(mintAccountInfo?.owner.equals(TOKEN_2022_PROGRAM_ID)).to.be.true;

      // For Token-2022, pass mint as the metadata account
      await program.methods
        .registerSymbolSol(symbol, 1, MAX_SOL_COST, 0)
        .accountsPartial({
          payer: admin.publicKey,
          config: configPda,
          tokenAccount: tokenPda,
          tokenMint: tokenMint,
          tokenMetadata: tokenMint, // Pass mint as metadata for Token-2022
          feeCollector: feeCollectorPubkey,
          solUsdPriceFeed: solUsdPythFeed,
          platformFeeAccount: null,
        })
        .rpc();

      const tokenAccount = await program.account.token.fetch(tokenPda);
      expect(tokenAccount.symbol).to.equal(symbol);
      expect(tokenAccount.mint.toString()).to.equal(tokenMint.toString());
    });

    it("rejects Token-2022 mint when passing Metaplex metadata PDA", async () => {
      const { program, admin, configPda, feeCollectorPubkey, solUsdPythFeed } = ctx;
      const symbol = "T22BAD";
      const tokenPda = getTokenPda(program.programId, symbol);

      // Create Token-2022 mint with embedded metadata
      const tokenMint = await createToken2022WithMetadata(
        ctx.provider,
        ctx.admin,
        symbol,
        `${symbol} Token`
      );

      // Try to pass Metaplex metadata PDA instead of mint
      const metaplexMetadataPda = getMetadataPda(tokenMint);

      try {
        await program.methods
          .registerSymbolSol(symbol, 1, MAX_SOL_COST, 0)
          .accountsPartial({
            payer: admin.publicKey,
            config: configPda,
            tokenAccount: tokenPda,
            tokenMint: tokenMint,
            tokenMetadata: metaplexMetadataPda, // Wrong! Should be mint for Token-2022
            feeCollector: feeCollectorPubkey,
            solUsdPriceFeed: solUsdPythFeed,
            platformFeeAccount: null,
          })
          .rpc();

        expect.fail("Should have rejected Token-2022 mint with Metaplex metadata PDA");
      } catch (err: any) {
        expect(err.error?.errorCode?.code || err.message).to.include("InvalidMetadata");
      }
    });
  });

  describe("Classic SPL mints (Metaplex metadata)", () => {
    it("registers classic SPL mint when passing Metaplex metadata PDA", async () => {
      const { program, admin, configPda, feeCollectorPubkey, solUsdPythFeed } = ctx;
      const symbol = "SPLOK";
      const tokenPda = getTokenPda(program.programId, symbol);

      // Create classic SPL mint with Metaplex metadata
      const tokenMint = await createTokenWithMetadata(
        ctx.provider,
        ctx.admin,
        symbol,
        `${symbol} Token`,
        true
      );

      // Verify it's NOT a Token-2022 mint
      const mintAccountInfo = await ctx.provider.connection.getAccountInfo(tokenMint);
      expect(mintAccountInfo?.owner.equals(TOKEN_2022_PROGRAM_ID)).to.be.false;

      // For classic SPL, pass Metaplex metadata PDA
      const tokenMetadata = getMetadataPda(tokenMint);

      await program.methods
        .registerSymbolSol(symbol, 1, MAX_SOL_COST, 0)
        .accountsPartial({
          payer: admin.publicKey,
          config: configPda,
          tokenAccount: tokenPda,
          tokenMint: tokenMint,
          tokenMetadata: tokenMetadata, // Metaplex PDA for classic SPL
          feeCollector: feeCollectorPubkey,
          solUsdPriceFeed: solUsdPythFeed,
          platformFeeAccount: null,
        })
        .rpc();

      const tokenAccount = await program.account.token.fetch(tokenPda);
      expect(tokenAccount.symbol).to.equal(symbol);
      expect(tokenAccount.mint.toString()).to.equal(tokenMint.toString());
    });

    it("rejects classic SPL mint when passing mint as metadata", async () => {
      const { program, admin, configPda, feeCollectorPubkey, solUsdPythFeed } = ctx;
      const symbol = "SPLBAD";
      const tokenPda = getTokenPda(program.programId, symbol);

      // Create classic SPL mint with Metaplex metadata
      const tokenMint = await createTokenWithMetadata(
        ctx.provider,
        ctx.admin,
        symbol,
        `${symbol} Token`,
        true
      );

      try {
        await program.methods
          .registerSymbolSol(symbol, 1, MAX_SOL_COST, 0)
          .accountsPartial({
            payer: admin.publicKey,
            config: configPda,
            tokenAccount: tokenPda,
            tokenMint: tokenMint,
            tokenMetadata: tokenMint, // Wrong! Should be Metaplex PDA for classic SPL
            feeCollector: feeCollectorPubkey,
            solUsdPriceFeed: solUsdPythFeed,
            platformFeeAccount: null,
          })
          .rpc();

        expect.fail("Should have rejected classic SPL mint with mint as metadata");
      } catch (err: any) {
        expect(err.error?.errorCode?.code || err.message).to.include("InvalidMetadata");
      }
    });
  });

  describe("Symbol mismatch protection", () => {
    it("rejects Token-2022 mint with mismatched symbol", async () => {
      const { program, admin, configPda, feeCollectorPubkey, solUsdPythFeed } = ctx;
      const actualSymbol = "REAL22";
      const attemptedSymbol = "FAKE22";
      const tokenPda = getTokenPda(program.programId, attemptedSymbol);

      // Create Token-2022 mint with actual symbol
      const tokenMint = await createToken2022WithMetadata(
        ctx.provider,
        ctx.admin,
        actualSymbol,
        `${actualSymbol} Token`
      );

      try {
        // Try to register with different symbol
        await program.methods
          .registerSymbolSol(attemptedSymbol, 1, MAX_SOL_COST, 0)
          .accountsPartial({
            payer: admin.publicKey,
            config: configPda,
            tokenAccount: tokenPda,
            tokenMint: tokenMint,
            tokenMetadata: tokenMint,
            feeCollector: feeCollectorPubkey,
            solUsdPriceFeed: solUsdPythFeed,
            platformFeeAccount: null,
          })
          .rpc();

        expect.fail("Should have rejected mismatched symbol");
      } catch (err: any) {
        expect(err.error?.errorCode?.code || err.message).to.include("MetadataSymbolMismatch");
      }
    });

    it("rejects classic SPL mint with mismatched symbol", async () => {
      const { program, admin, configPda, feeCollectorPubkey, solUsdPythFeed } = ctx;
      const actualSymbol = "REALSPL";
      const attemptedSymbol = "FAKESPL";
      const tokenPda = getTokenPda(program.programId, attemptedSymbol);

      // Create classic SPL mint with actual symbol
      const tokenMint = await createTokenWithMetadata(
        ctx.provider,
        ctx.admin,
        actualSymbol,
        `${actualSymbol} Token`,
        true
      );

      const tokenMetadata = getMetadataPda(tokenMint);

      try {
        // Try to register with different symbol
        await program.methods
          .registerSymbolSol(attemptedSymbol, 1, MAX_SOL_COST, 0)
          .accountsPartial({
            payer: admin.publicKey,
            config: configPda,
            tokenAccount: tokenPda,
            tokenMint: tokenMint,
            tokenMetadata: tokenMetadata,
            feeCollector: feeCollectorPubkey,
            solUsdPriceFeed: solUsdPythFeed,
            platformFeeAccount: null,
          })
          .rpc();

        expect.fail("Should have rejected mismatched symbol");
      } catch (err: any) {
        expect(err.error?.errorCode?.code || err.message).to.include("MetadataSymbolMismatch");
      }
    });
  });

  describe("Admin seed with Token-2022", () => {
    it("admin can seed Token-2022 mint", async () => {
      const { program, admin, configPda } = ctx;
      const symbol = "SEED22";
      const tokenPda = getTokenPda(program.programId, symbol);
      const owner = Keypair.generate().publicKey;

      // Create Token-2022 mint with embedded metadata
      const tokenMint = await createToken2022WithMetadata(
        ctx.provider,
        ctx.admin,
        symbol,
        `${symbol} Token`
      );

      await program.methods
        .seedSymbol(symbol, 10, owner)
        .accountsPartial({
          admin: admin.publicKey,
          config: configPda,
          tokenAccount: tokenPda,
          tokenMint: tokenMint,
          tokenMetadata: tokenMint, // Pass mint as metadata for Token-2022
        })
        .rpc();

      const tokenAccount = await program.account.token.fetch(tokenPda);
      expect(tokenAccount.symbol).to.equal(symbol);
      expect(tokenAccount.mint.toString()).to.equal(tokenMint.toString());
      expect(tokenAccount.owner.toString()).to.equal(owner.toString());
    });
  });
});
