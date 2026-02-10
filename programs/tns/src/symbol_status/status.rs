use super::reserved::is_reserved_tradfi;

/// Symbol status for registration access control
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SymbolStatus {
    /// Symbol is reserved for TradFi (stocks, ETFs, securities)
    /// Admin-only until Phase 3 (RWA tokenization)
    ReservedTradfi,
    /// Symbol is not reserved - can be registered normally
    NotListed,
}

/// Check if a symbol is reserved
///
/// Returns:
/// - SymbolStatus::ReservedTradfi if the symbol is a reserved TradFi ticker
/// - SymbolStatus::NotListed if the symbol is not reserved
pub fn get_symbol_status(symbol: &str) -> SymbolStatus {
    if is_reserved_tradfi(symbol) {
        return SymbolStatus::ReservedTradfi;
    }
    SymbolStatus::NotListed
}
