import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { expect } from "chai";
import {
  createMint,
  mintTo,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import {
  setupTest,
  TestContext,
  ensureConfigInitialized,
  fundAccounts,
  getTokenPda,
  refreshConfigState,
  ensureUnpaused,
  createTokenWithMetadata,
  getMetadataPda,
  TOKEN_METADATA_PROGRAM_ID,
} from "./helpers/setup";

// Max slippage for tests (1 SOL)
const MAX_SOL_COST = new BN(1_000_000_000);

/**
 * Create a CreateMetadataAccountV3 instruction for testing.
 */
function createMetadataV3Ix(
  metadataPda: PublicKey,
  mint: PublicKey,
  mintAuthority: PublicKey,
  payer: PublicKey,
  updateAuthority: PublicKey,
  name: string,
  symbol: string,
  uri: string,
  isMutable: boolean
): TransactionInstruction {
  const serializeString = (str: string): Buffer => {
    const bytes = Buffer.from(str, "utf8");
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(bytes.length, 0);
    return Buffer.concat([lenBuf, bytes]);
  };

  const parts: Buffer[] = [];
  parts.push(Buffer.from([33])); // CreateMetadataAccountV3 discriminator
  parts.push(serializeString(name));
  parts.push(serializeString(symbol));
  parts.push(serializeString(uri));
  const feeBuf = Buffer.alloc(2);
  feeBuf.writeUInt16LE(0, 0);
  parts.push(feeBuf);
  parts.push(Buffer.from([0])); // creators: None
  parts.push(Buffer.from([0])); // collection: None
  parts.push(Buffer.from([0])); // uses: None
  parts.push(Buffer.from([isMutable ? 1 : 0]));
  parts.push(Buffer.from([0])); // collection_details: None

  return new TransactionInstruction({
    keys: [
      { pubkey: metadataPda, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: mintAuthority, isSigner: true, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: updateAuthority, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: TOKEN_METADATA_PROGRAM_ID,
    data: Buffer.concat(parts),
  });
}

describe("TNS - Claim Ownership", () => {
  let ctx: TestContext;
  const testSymbol = "CLAIM";
  let tokenPda: anchor.web3.PublicKey;
  let testTokenMint: anchor.web3.PublicKey;
  let testTokenMetadata: anchor.web3.PublicKey;
  let differentOwner: Keypair;

  before(async () => {
    ctx = setupTest();
    await ensureConfigInitialized(ctx);
    differentOwner = Keypair.generate();
    await fundAccounts(ctx.provider, ctx.registrant, ctx.feeCollector, differentOwner);

    // Refresh config to get current state
    await refreshConfigState(ctx);

    // Ensure protocol is unpaused (test isolation)
    await ensureUnpaused(ctx);

    // Create a test token mint with metadata (admin is update authority)
    testTokenMint = await createTokenWithMetadata(
      ctx.provider,
      ctx.admin,
      testSymbol,
      `${testSymbol} Token`,
      true // immutable
    );
    testTokenMetadata = getMetadataPda(testTokenMint);

    // Register the symbol (as admin for Phase 1)
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

    // Transfer ownership to a different owner (so admin can claim it back)
    await ctx.program.methods
      .transferOwnership(differentOwner.publicKey)
      .accountsPartial({
        owner: ctx.admin.publicKey,
        config: ctx.configPda,
        tokenAccount: tokenPda,
      })
      .rpc();
  });

  it("update authority can claim ownership", async () => {
    const { program, admin, configPda } = ctx;

    // Verify current owner is differentOwner
    const tokenBefore = await program.account.token.fetch(tokenPda);
    expect(tokenBefore.owner.toString()).to.equal(differentOwner.publicKey.toString());

    // Admin is the update authority, so they can claim
    await program.methods
      .claimOwnership()
      .accountsPartial({
        claimant: admin.publicKey,
        config: configPda,
        tokenAccount: tokenPda,
        tokenMint: testTokenMint,
        tokenMetadata: testTokenMetadata,
        claimantTokenAccount: null, // Not using majority holder path
      })
      .rpc();

    const tokenAfter = await program.account.token.fetch(tokenPda);
    expect(tokenAfter.owner.toString()).to.equal(admin.publicKey.toString());
  });

  it("fails if already owner", async () => {
    const { program, admin, configPda } = ctx;

    // Admin is now the owner from previous test
    try {
      await program.methods
        .claimOwnership()
        .accountsPartial({
          claimant: admin.publicKey,
          config: configPda,
          tokenAccount: tokenPda,
          tokenMint: testTokenMint,
          tokenMetadata: testTokenMetadata,
          claimantTokenAccount: null,
        })
        .rpc();

      expect.fail("Should have thrown an error");
    } catch (err) {
      expect(err.message).to.include("AlreadyOwner");
    }
  });

  it("fails if not authority and not majority holder", async () => {
    const { program, configPda, registrant } = ctx;

    // Transfer ownership away from admin first
    await program.methods
      .transferOwnership(differentOwner.publicKey)
      .accountsPartial({
        owner: ctx.admin.publicKey,
        config: configPda,
        tokenAccount: tokenPda,
      })
      .rpc();

    // Registrant is not the update authority, mint authority, or majority holder
    try {
      await program.methods
        .claimOwnership()
        .accountsPartial({
          claimant: registrant.publicKey,
          config: configPda,
          tokenAccount: tokenPda,
          tokenMint: testTokenMint,
          tokenMetadata: testTokenMetadata,
          claimantTokenAccount: null,
        })
        .signers([registrant])
        .rpc();

      expect.fail("Should have thrown an error");
    } catch (err) {
      expect(err.message).to.include("NotTokenAuthority");
    }
  });

  describe("mint authority claim", () => {
    const mintAuthSymbol = "MINTAUTH";
    let mintAuthTokenMint: PublicKey;
    let mintAuthTokenMetadata: PublicKey;
    let mintAuthTokenPda: PublicKey;
    let symbolOwner: Keypair;

    before(async () => {
      symbolOwner = Keypair.generate();
      await fundAccounts(ctx.provider, symbolOwner);

      // Create token with metadata - admin is both mint authority and update authority
      mintAuthTokenMint = await createTokenWithMetadata(
        ctx.provider,
        ctx.admin,
        mintAuthSymbol,
        `${mintAuthSymbol} Token`,
        true // immutable metadata
      );
      mintAuthTokenMetadata = getMetadataPda(mintAuthTokenMint);
      mintAuthTokenPda = getTokenPda(ctx.program.programId, mintAuthSymbol);

      // Register symbol (admin in Phase 1)
      await ctx.program.methods
        .registerSymbolSol(mintAuthSymbol, 1, MAX_SOL_COST, 0)
        .accountsPartial({
          payer: ctx.admin.publicKey,
          config: ctx.configPda,
          tokenAccount: mintAuthTokenPda,
          tokenMint: mintAuthTokenMint,
          tokenMetadata: mintAuthTokenMetadata,
          feeCollector: ctx.feeCollectorPubkey,
          priceUpdate: ctx.priceUpdate,
          platformFeeAccount: null,
        })
        .rpc();

      // Transfer ownership to someone else
      await ctx.program.methods
        .transferOwnership(symbolOwner.publicKey)
        .accountsPartial({
          owner: ctx.admin.publicKey,
          config: ctx.configPda,
          tokenAccount: mintAuthTokenPda,
        })
        .rpc();
    });

    it("mint authority can claim ownership", async () => {
      const { program, admin, configPda } = ctx;

      // Verify current owner is symbolOwner
      const tokenBefore = await program.account.token.fetch(mintAuthTokenPda);
      expect(tokenBefore.owner.toString()).to.equal(symbolOwner.publicKey.toString());

      // Admin is the mint authority (from createMint), so they can claim
      await program.methods
        .claimOwnership()
        .accountsPartial({
          claimant: admin.publicKey,
          config: configPda,
          tokenAccount: mintAuthTokenPda,
          tokenMint: mintAuthTokenMint,
          tokenMetadata: mintAuthTokenMetadata,
          claimantTokenAccount: null, // Not using majority holder path
        })
        .rpc();

      const tokenAfter = await program.account.token.fetch(mintAuthTokenPda);
      expect(tokenAfter.owner.toString()).to.equal(admin.publicKey.toString());
    });
  });

  describe("majority holder claim", () => {
    const majoritySymbol = "MAJOR";
    let majorityMint: PublicKey;
    let majorityMetadata: PublicKey;
    let majorityPda: PublicKey;
    let majorityHolder: Keypair;
    let symbolOwner: Keypair;
    let mintAuthority: Keypair;

    before(async () => {
      majorityHolder = Keypair.generate();
      symbolOwner = Keypair.generate();
      mintAuthority = Keypair.generate();
      await fundAccounts(ctx.provider, majorityHolder, symbolOwner, mintAuthority);

      // Create mint with our controlled mint authority
      majorityMint = await createMint(
        ctx.provider.connection,
        mintAuthority,
        mintAuthority.publicKey, // mint authority we control
        null,
        9
      );

      // Create metadata using the helper pattern
      majorityMetadata = getMetadataPda(majorityMint);

      // Create metadata for the mint (using mintAuthority as update authority)
      const createMetadataIx = createMetadataV3Ix(
        majorityMetadata,
        majorityMint,
        mintAuthority.publicKey,
        mintAuthority.publicKey,
        mintAuthority.publicKey,
        `${majoritySymbol} Token`,
        majoritySymbol,
        "",
        false // mutable = false (immutable)
      );

      const tx = new anchor.web3.Transaction().add(createMetadataIx);
      await anchor.web3.sendAndConfirmTransaction(ctx.provider.connection, tx, [mintAuthority]);

      majorityPda = getTokenPda(ctx.program.programId, majoritySymbol);

      // Mint 100 tokens total: 60 to majorityHolder, 40 to symbolOwner
      const holderAta = await getOrCreateAssociatedTokenAccount(
        ctx.provider.connection,
        mintAuthority,
        majorityMint,
        majorityHolder.publicKey
      );

      const ownerAta = await getOrCreateAssociatedTokenAccount(
        ctx.provider.connection,
        mintAuthority,
        majorityMint,
        symbolOwner.publicKey
      );

      // Mint 60 tokens to majority holder (60%)
      await mintTo(
        ctx.provider.connection,
        mintAuthority,
        majorityMint,
        holderAta.address,
        mintAuthority, // mint authority keypair
        60_000_000_000 // 60 tokens with 9 decimals
      );

      // Mint 40 tokens to symbol owner (40%)
      await mintTo(
        ctx.provider.connection,
        mintAuthority,
        majorityMint,
        ownerAta.address,
        mintAuthority,
        40_000_000_000 // 40 tokens with 9 decimals
      );

      // Register symbol with symbolOwner as the TNS owner
      await ctx.program.methods
        .registerSymbolSol(majoritySymbol, 1, MAX_SOL_COST, 0)
        .accountsPartial({
          payer: ctx.admin.publicKey,
          config: ctx.configPda,
          tokenAccount: majorityPda,
          tokenMint: majorityMint,
          tokenMetadata: majorityMetadata,
          feeCollector: ctx.feeCollectorPubkey,
          priceUpdate: ctx.priceUpdate,
          platformFeeAccount: null,
        })
        .rpc();

      // Transfer ownership to symbolOwner (who only has 40%)
      await ctx.program.methods
        .transferOwnership(symbolOwner.publicKey)
        .accountsPartial({
          owner: ctx.admin.publicKey,
          config: ctx.configPda,
          tokenAccount: majorityPda,
        })
        .rpc();
    });

    it("majority holder can claim ownership", async () => {
      const { program, configPda } = ctx;

      // Verify current owner is symbolOwner
      const tokenBefore = await program.account.token.fetch(majorityPda);
      expect(tokenBefore.owner.toString()).to.equal(symbolOwner.publicKey.toString());

      // Get majority holder's token account
      const holderAta = await getOrCreateAssociatedTokenAccount(
        ctx.provider.connection,
        mintAuthority,
        majorityMint,
        majorityHolder.publicKey
      );

      // Majority holder (60% of supply) can claim
      await program.methods
        .claimOwnership()
        .accountsPartial({
          claimant: majorityHolder.publicKey,
          config: configPda,
          tokenAccount: majorityPda,
          tokenMint: majorityMint,
          tokenMetadata: majorityMetadata,
          claimantTokenAccount: holderAta.address,
        })
        .signers([majorityHolder])
        .rpc();

      const tokenAfter = await program.account.token.fetch(majorityPda);
      expect(tokenAfter.owner.toString()).to.equal(majorityHolder.publicKey.toString());
    });

    it("non-majority holder cannot claim", async () => {
      const { program, configPda } = ctx;
      const nonMajorityHolder = Keypair.generate();
      await fundAccounts(ctx.provider, nonMajorityHolder);

      // Create a token account for non-majority holder with just 1 token
      const nonMajorityAta = await getOrCreateAssociatedTokenAccount(
        ctx.provider.connection,
        mintAuthority,
        majorityMint,
        nonMajorityHolder.publicKey
      );

      // Mint 1 token to them (less than 50%)
      await mintTo(
        ctx.provider.connection,
        mintAuthority,
        majorityMint,
        nonMajorityAta.address,
        mintAuthority,
        1_000_000_000 // 1 token
      );

      // Transfer ownership back to symbolOwner for this test
      await program.methods
        .transferOwnership(symbolOwner.publicKey)
        .accountsPartial({
          owner: majorityHolder.publicKey,
          config: configPda,
          tokenAccount: majorityPda,
        })
        .signers([majorityHolder])
        .rpc();

      // Non-majority holder cannot claim
      try {
        await program.methods
          .claimOwnership()
          .accountsPartial({
            claimant: nonMajorityHolder.publicKey,
            config: configPda,
            tokenAccount: majorityPda,
            tokenMint: majorityMint,
            tokenMetadata: majorityMetadata,
            claimantTokenAccount: nonMajorityAta.address,
          })
          .signers([nonMajorityHolder])
          .rpc();

        expect.fail("Should have thrown an error");
      } catch (err) {
        expect(err.message).to.include("NotTokenAuthority");
      }
    });

    it("exactly 50% holder cannot claim (requires >50%)", async () => {
      const { program, configPda } = ctx;
      const fiftyPercentHolder = Keypair.generate();
      await fundAccounts(ctx.provider, fiftyPercentHolder);

      // Get current total supply (should be 101 tokens from previous tests)
      const mintInfo = await ctx.provider.connection.getTokenSupply(majorityMint);
      const currentSupply = BigInt(mintInfo.value.amount);

      // Create token account for 50% holder
      const fiftyAta = await getOrCreateAssociatedTokenAccount(
        ctx.provider.connection,
        mintAuthority,
        majorityMint,
        fiftyPercentHolder.publicKey
      );

      // Mint exactly the same amount as current supply to make them 50%
      // After minting: currentSupply + currentSupply = 2*currentSupply
      // fiftyPercentHolder has currentSupply = exactly 50%
      await mintTo(
        ctx.provider.connection,
        mintAuthority,
        majorityMint,
        fiftyAta.address,
        mintAuthority,
        currentSupply
      );

      // Exactly 50% holder cannot claim
      try {
        await program.methods
          .claimOwnership()
          .accountsPartial({
            claimant: fiftyPercentHolder.publicKey,
            config: configPda,
            tokenAccount: majorityPda,
            tokenMint: majorityMint,
            tokenMetadata: majorityMetadata,
            claimantTokenAccount: fiftyAta.address,
          })
          .signers([fiftyPercentHolder])
          .rpc();

        expect.fail("Should have thrown an error");
      } catch (err) {
        expect(err.message).to.include("NotTokenAuthority");
      }
    });
  });
});
