use anchor_lang::prelude::*;
use crate::{Config, Token, SymbolCanceled, TnsError, KEEPER_REWARD_LAMPORTS};
use super::helpers::validate_not_paused;

/// Cancel an abandoned symbol (1+ year past grace period)
/// This closes the account entirely, returning rent to the caller
/// Keeper also receives fixed reward from the Config PDA
/// The symbol becomes available for fresh registration
#[derive(Accounts)]
pub struct CancelSymbol<'info> {
    /// Anyone can cancel an abandoned symbol - receives rent + keeper reward
    #[account(mut)]
    pub keeper: Signer<'info>,

    /// Config PDA holds keeper reward lamports
    #[account(
        mut,
        seeds = [Config::SEED_PREFIX],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [Token::SEED_PREFIX, token_account.symbol.as_bytes()],
        bump = token_account.bump,
        close = keeper,
    )]
    pub token_account: Account<'info, Token>,
}

pub fn handler(ctx: Context<CancelSymbol>) -> Result<()> {
    let clock = Clock::get()?;
    let token_account = &ctx.accounts.token_account;

    // Validate not paused
    validate_not_paused(&ctx.accounts.config)?;

    // Verify the symbol is cancelable (1 year past grace period)
    require!(
        token_account.is_cancelable(clock.unix_timestamp),
        TnsError::NotYetCancelable
    );

    // Capture values for event before account is closed
    let token_account_key = ctx.accounts.token_account.key();
    let symbol_str = token_account.symbol.clone();
    let previous_owner = token_account.owner;
    let previous_mint = token_account.mint;
    let keeper_key = ctx.accounts.keeper.key();
    let rent_returned = ctx.accounts.token_account.to_account_info().lamports();

    // Pay keeper reward from Config PDA (fixed 0.01 SOL)
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

    emit!(SymbolCanceled {
        token_account: token_account_key,
        symbol: symbol_str,
        previous_owner,
        previous_mint,
        canceled_by: keeper_key,
        canceled_at: clock.unix_timestamp,
        rent_returned,
    });

    // Account closure is handled by Anchor's close = keeper constraint
    Ok(())
}
