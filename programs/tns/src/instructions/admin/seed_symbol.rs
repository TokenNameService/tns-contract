use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;
use crate::{Config, Token, TnsError, SymbolSeeded, SECONDS_PER_YEAR};
use crate::instructions::registrar::helpers::validate_symbol_format;

/// Admin-only instruction to seed the registry with verified tokens.
/// No fee, sets owner to mint authority, 10-year expiration.
#[derive(Accounts)]
#[instruction(symbol: String)]
pub struct SeedSymbol<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [Config::SEED_PREFIX],
        bump = config.bump,
        has_one = admin @ TnsError::Unauthorized,
    )]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = admin,
        space = 8 + Token::INIT_SPACE,
        seeds = [Token::SEED_PREFIX, symbol.to_uppercase().as_bytes()],
        bump
    )]
    pub token_account: Account<'info, Token>,

    /// The verified token mint - owner becomes the mint authority
    pub token_mint: InterfaceAccount<'info, Mint>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<SeedSymbol>, symbol: String) -> Result<()> {
    let clock = Clock::get()?;
    let normalized_symbol = validate_symbol_format(&symbol)?;

    // Get the mint authority - this becomes the symbol owner
    let owner = ctx.accounts.token_mint.mint_authority
        .ok_or(TnsError::InvalidMint)?;

    // Capture keys before mutable borrow for event emission
    let token_account_key = ctx.accounts.token_account.key();
    let mint_key = ctx.accounts.token_mint.key();
    let expires_at = clock.unix_timestamp + (10 * SECONDS_PER_YEAR);

    let token_account = &mut ctx.accounts.token_account;
    token_account.symbol = normalized_symbol.clone();
    token_account.mint = mint_key;
    token_account.owner = owner;
    token_account.registered_at = clock.unix_timestamp;
    token_account.expires_at = expires_at;
    token_account.bump = ctx.bumps.token_account;
    token_account._reserved = [0u8; 64];

    emit!(SymbolSeeded {
        token_account: token_account_key,
        symbol: normalized_symbol,
        mint: mint_key,
        owner,
        seeded_at: clock.unix_timestamp,
        expires_at,
    });

    Ok(())
}
