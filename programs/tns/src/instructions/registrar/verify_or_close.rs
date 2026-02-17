use anchor_lang::prelude::*;
use crate::{Config, Token, SymbolDriftDetected, TnsError, KEEPER_REWARD_LAMPORTS};
use super::helpers::parse_metadata;

/// Close a symbol registration when metadata drift is detected.
///
/// This instruction succeeds only when the token's on-chain metadata symbol
/// no longer matches the registered TNS symbol. If symbols still match,
/// the instruction fails with NoDriftDetected.
///
/// Keepers should detect drift off-chain before calling this instruction.
/// On success, the keeper receives the account rent plus a keeper reward.
///
/// Economic enforcement: changing your metadata symbol after registration
/// means anyone can close your registration and claim the rent.
#[derive(Accounts)]
pub struct VerifyOrClose<'info> {
    /// Anyone can call this - receives rent if account is closed due to drift
    #[account(mut)]
    pub keeper: Signer<'info>,

    /// Config PDA holds keeper reward lamports
    #[account(
        mut,
        seeds = [Config::SEED_PREFIX],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    /// The token account to close (only succeeds if drift detected)
    #[account(
        mut,
        seeds = [Token::SEED_PREFIX, token_account.symbol.as_bytes()],
        bump = token_account.bump,
        close = keeper,
    )]
    pub token_account: Account<'info, Token>,

    /// The mint's metadata account
    /// CHECK: Validated via parse_metadata helper
    pub token_metadata: AccountInfo<'info>,
}

pub fn handler(ctx: Context<VerifyOrClose>) -> Result<()> {
    let token = &ctx.accounts.token_account;
    let clock = Clock::get()?;

    // Parse and validate metadata
    let metadata = parse_metadata(&ctx.accounts.token_metadata, &token.mint)?;
    let metadata_symbol = metadata.symbol.trim_matches('\0');

    // Require drift - fail if symbols still match
    require!(
        metadata_symbol != token.symbol,
        TnsError::NoDriftDetected
    );

    // Capture data for event before Anchor closes the account
    let rent_returned = ctx.accounts.token_account.to_account_info().lamports();
    let symbol = token.symbol.clone();
    let mint = token.mint;
    let previous_owner = token.owner;

    // Pay keeper reward from Config PDA
    let keeper_reward = KEEPER_REWARD_LAMPORTS;
    let config_info = ctx.accounts.config.to_account_info();
    let config_balance = config_info.lamports();

    // Get minimum rent for the config account
    let rent = Rent::get()?;
    let min_rent = rent.minimum_balance(8 + Config::INIT_SPACE);

    // Only pay if config has sufficient balance (above rent-exempt minimum)
    if config_balance > min_rent + keeper_reward {
        let keeper_info = ctx.accounts.keeper.to_account_info();

        **config_info.try_borrow_mut_lamports()? -= keeper_reward;
        **keeper_info.try_borrow_mut_lamports()? += keeper_reward;
    }

    // Emit event at end (account closure handled by Anchor's close constraint)
    emit!(SymbolDriftDetected {
        token_account: ctx.accounts.token_account.key(),
        symbol,
        new_metadata_symbol: metadata_symbol.to_string(),
        mint,
        previous_owner,
        keeper: ctx.accounts.keeper.key(),
        detected_at: clock.unix_timestamp,
        rent_returned,
    });

    Ok(())
}
