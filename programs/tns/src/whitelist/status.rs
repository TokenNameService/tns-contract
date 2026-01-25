use anchor_lang::prelude::*;

/// Master lists
use super::data::{
    VERIFIED_TOKENS,
    SP500_SYMBOLS,
    SP400_SYMBOLS,
    SP600_SYMBOLS,
    DOW_SYMBOLS,
    NASDAQ100_SYMBOLS,
    RUSSELL3000_SYMBOLS,
};

/// Which index a reserved symbol belongs to
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ReservedIndex {
    SP500,
    SP400,
    SP600,
    Dow,
    Nasdaq100,
    Russell3000,
}

/// Whitelist status for a symbol
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SymbolStatus {
    /// Symbol is on whitelist with a verified mint - only mint authority can register
    Verified(Pubkey),
    /// Symbol is reserved (e.g., AAPL, GOOGL) - cannot be registered until Phase 3
    Reserved(ReservedIndex),
    /// Symbol is not on whitelist - only admin can register in Phase 1
    NotListed,
}

/// Check whitelist status for a symbol
/// This is the main entry point for whitelist checks
/// Checks in order:
/// US Stock Market
/// S&P 500 -> S&P 400 -> S&P 600 -> DOW -> NASDAQ 100 -> Russell 3000
///
/// Returns:
/// - SymbolStatus::Verified(mint) if the symbol is a verified crypto token
/// - SymbolStatus::Reserved(index) if the symbol is a reserved TradFi ticker
/// - SymbolStatus::NotListed if the symbol is not on any list
pub fn get_symbol_status(symbol: &str) -> SymbolStatus {
    let normalized = symbol.to_uppercase();

    // Check verified crypto tokens first (takes highest priority)
    if let Some(mint_str) = VERIFIED_TOKENS.get(normalized.as_str()) {
        // Parse the mint address string to Pubkey
        if let Ok(mint) = mint_str.parse::<Pubkey>() {
            return SymbolStatus::Verified(mint);
        }
    }

    // Check reserved TradFi symbols in order of priority
    if SP500_SYMBOLS.contains(normalized.as_str()) {
        return SymbolStatus::Reserved(ReservedIndex::SP500);
    }

    if SP400_SYMBOLS.contains(normalized.as_str()) {
        return SymbolStatus::Reserved(ReservedIndex::SP400);
    }

    if SP600_SYMBOLS.contains(normalized.as_str()) {
        return SymbolStatus::Reserved(ReservedIndex::SP600);
    }

    if DOW_SYMBOLS.contains(normalized.as_str()) {
        return SymbolStatus::Reserved(ReservedIndex::Dow);
    }

    if NASDAQ100_SYMBOLS.contains(normalized.as_str()) {
        return SymbolStatus::Reserved(ReservedIndex::Nasdaq100);
    }

    if RUSSELL3000_SYMBOLS.contains(normalized.as_str()) {
        return SymbolStatus::Reserved(ReservedIndex::Russell3000);
    }

    // Not on any list
    SymbolStatus::NotListed
}