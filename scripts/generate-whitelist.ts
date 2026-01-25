/**
 * Generate Rust whitelist code from JSON data files
 *
 * This script reads the fetched token and symbol data and generates
 * the Rust source code using phf for O(1) lookups.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface VerifiedTokensData {
  tokens: Record<string, string>;
  count: number;
}

interface TradFiSymbolsData {
  symbols: string[];
  count: number;
}

function loadVerifiedTokens(): Record<string, string> {
  const path = join(__dirname, "data", "verified-tokens.json");
  if (!existsSync(path)) {
    console.error("verified-tokens.json not found. Run: npm run fetch:jupiter");
    process.exit(1);
  }
  const data = JSON.parse(readFileSync(path, "utf-8")) as VerifiedTokensData;
  return data.tokens;
}

function loadTradFiSymbols(): string[] {
  const path = join(__dirname, "data", "tradfi-symbols.json");
  if (!existsSync(path)) {
    console.error("tradfi-symbols.json not found. Run: npm run fetch:tradfi");
    process.exit(1);
  }
  const data = JSON.parse(readFileSync(path, "utf-8")) as TradFiSymbolsData;
  return data.symbols;
}

function generateRustCode(
  verifiedTokens: Record<string, string>,
  tradfiSymbols: string[]
): string {
  const verifiedEntries = Object.entries(verifiedTokens)
    .map(([symbol, mint]) => `    "${symbol}" => "${mint}"`)
    .join(",\n");

  const tradfiEntries = tradfiSymbols
    .map((symbol) => `    "${symbol}"`)
    .join(",\n");

  return `//! Auto-generated whitelist data
//! Generated at: ${new Date().toISOString()}
//!
//! DO NOT EDIT MANUALLY - regenerate with: npm run generate
//!
//! Verified tokens: ${Object.keys(verifiedTokens).length}
//! Reserved TradFi symbols: ${tradfiSymbols.length}

use phf::phf_map;
use phf::phf_set;

/// Verified tokens from community-verified token lists
/// Maps symbol -> mint address
pub static VERIFIED_TOKENS: phf::Map<&'static str, &'static str> = phf_map! {
${verifiedEntries}
};

/// Reserved TradFi symbols (S&P 500, Russell 3000)
/// These cannot be registered until Phase 3
pub static RESERVED_SYMBOLS: phf::Set<&'static str> = phf_set! {
${tradfiEntries}
};

/// Total number of verified tokens
pub const VERIFIED_TOKEN_COUNT: usize = ${Object.keys(verifiedTokens).length};

/// Total number of reserved symbols
pub const RESERVED_SYMBOL_COUNT: usize = ${tradfiSymbols.length};
`;
}

function main() {
  console.log("Loading data files...");

  const verifiedTokens = loadVerifiedTokens();
  console.log(`Loaded ${Object.keys(verifiedTokens).length} verified tokens`);

  const tradfiSymbols = loadTradFiSymbols();
  console.log(`Loaded ${tradfiSymbols.length} TradFi symbols`);

  // Check for conflicts (crypto symbols that match TradFi)
  const conflicts: string[] = [];
  for (const symbol of Object.keys(verifiedTokens)) {
    if (tradfiSymbols.includes(symbol)) {
      conflicts.push(symbol);
    }
  }

  if (conflicts.length > 0) {
    console.log(`\nWarning: ${conflicts.length} symbols appear in both lists:`);
    console.log(conflicts.join(", "));
    console.log(
      "These will be treated as verified tokens (crypto takes priority)\n"
    );

    // Remove conflicts from TradFi list (crypto wins)
    const filteredTradfi = tradfiSymbols.filter((s) => !conflicts.includes(s));
    console.log(`Filtered TradFi list: ${filteredTradfi.length} symbols`);

    const rustCode = generateRustCode(verifiedTokens, filteredTradfi);
    const outputPath = join(
      __dirname,
      "..",
      "programs",
      "tns",
      "src",
      "whitelist_data.rs"
    );
    writeFileSync(outputPath, rustCode);
    console.log(`\nGenerated ${outputPath}`);
  } else {
    const rustCode = generateRustCode(verifiedTokens, tradfiSymbols);
    const outputPath = join(
      __dirname,
      "..",
      "programs",
      "tns",
      "src",
      "whitelist_data.rs"
    );
    writeFileSync(outputPath, rustCode);
    console.log(`\nGenerated ${outputPath}`);
  }

  console.log(
    "\nDone! Remember to update whitelist.rs to use the generated data."
  );
}

main();
