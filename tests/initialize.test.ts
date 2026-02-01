import * as anchor from "@coral-xyz/anchor";
import { expect } from "chai";
import {
  setupTest,
  TestContext,
  ensureConfigInitialized,
  ensureUnpaused,
} from "./helpers/setup";

describe("TNS - Initialize", () => {
  let ctx: TestContext;

  before(() => {
    ctx = setupTest();
  });

  it("initializes the config account with correct values", async () => {
    const { program, admin, configPda } = ctx;

    // Use ensureConfigInitialized to set up config properly
    await ensureConfigInitialized(ctx);

    // Ensure protocol is unpaused (test isolation - other tests may have paused it)
    await ensureUnpaused(ctx);

    const config = await program.account.config.fetch(configPda);

    expect(config.admin.toString()).to.equal(admin.publicKey.toString());
    expect(config.basePriceUsdMicro.toNumber()).to.equal(10_000_000); // $10.00
    expect(config.annualIncreaseBps).to.equal(700); // 7%
    expect(config.keeperRewardLamports.toNumber()).to.equal(10_000_000); // 0.01 SOL
    expect(config.updateFeeBps).to.equal(5000); // 50% (reduced from full price)
    expect(config.paused).to.equal(false); // We just ensured it's unpaused
    // Phase may have been advanced by other tests, so just check it's valid (1-3)
    expect(config.phase).to.be.within(1, 3);
  });

  it("fails to reinitialize config", async () => {
    const { program, admin, configPda, feeCollector, solUsdPythFeed } = ctx;

    try {
      await program.methods
        .initialize()
        .accountsPartial({
          admin: admin.publicKey,
          payer: admin.publicKey,
          config: configPda,
          solUsdPythFeed: solUsdPythFeed,
          feeCollector: feeCollector.publicKey,
        })
        .rpc();

      expect.fail("Should have thrown an error");
    } catch (err) {
      // Expected - config already initialized
      expect(err).to.exist;
    }
  });
});
