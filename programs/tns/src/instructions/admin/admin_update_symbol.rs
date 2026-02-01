use anchor_lang::prelude::*;
use crate::{Config, Token, TnsError, SymbolUpdatedByAdmin};

/// Admin-only instruction to force-update a symbol's owner, mint, or expiration.
/// Use cases: fix mistakes, revoke from bad actors, extend expiration for partners.
#[derive(Accounts)]
pub struct AdminUpdateSymbol<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [Config::SEED_PREFIX],
        bump = config.bump,
        has_one = admin @ TnsError::Unauthorized,
    )]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub token_account: Account<'info, Token>,
}

pub fn handler(
    ctx: Context<AdminUpdateSymbol>,
    new_owner: Option<Pubkey>,
    new_mint: Option<Pubkey>,
    new_expires_at: Option<i64>,
) -> Result<()> {
    let clock = Clock::get()?;

    // Capture keys before mutable borrow
    let token_account_key = ctx.accounts.token_account.key();
    let admin_key = ctx.accounts.admin.key();

    let token = &mut ctx.accounts.token_account;

    // Capture old values for event
    let old_owner = token.owner;
    let old_mint = token.mint;
    let old_expires_at = token.expires_at;
    let symbol = token.symbol.clone();

    // Apply updates
    if let Some(owner) = new_owner {
        token.owner = owner;
    }

    if let Some(mint) = new_mint {
        token.mint = mint;
    }

    if let Some(expires_at) = new_expires_at {
        token.expires_at = expires_at;
    }

    emit!(SymbolUpdatedByAdmin {
        token_account: token_account_key,
        symbol,
        old_owner,
        new_owner: token.owner,
        old_mint,
        new_mint: token.mint,
        old_expires_at,
        new_expires_at: token.expires_at,
        admin: admin_key,
        updated_at: clock.unix_timestamp,
    });

    Ok(())
}
