/**
 * Generate Rust code from reserved symbol JSON files
 *
 * Creates a SINGLE deduplicated RESERVED_TRADFI phf_set from all sources.
 * Sources are documented in header comments for transparency.
 *
 * Sources (merged in this order):
 *   1. Dow Jones Industrial Average
 *   2. S&P 500
 *   3. S&P 400 (Mid Cap)
 *   4. S&P 600 (Small Cap)
 *   5. NASDAQ 100
 *   6. FMP Stocks (all global securities)
 *   7. FMP ETFs
 *
 * Usage:
 *   npx tsx scripts/reserved/generateRustCode.ts
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface JsonData {
  name: string;
  source: string;
  sourceType: string;
  fetchedAt: string;
  count: number;
  symbols: Array<{
    symbol: string;
    name: string;
    sector?: string;
    industry?: string;
    exchange?: string;
  }>;
}

interface SourceInfo {
  file: string;
  displayName: string;
  url: string;
}

// Sources in priority order
const SOURCES: SourceInfo[] = [
  {
    file: "dow.json",
    displayName: "Dow Jones Industrial Average",
    url: "https://en.wikipedia.org/wiki/Dow_Jones_Industrial_Average",
  },
  {
    file: "sp500.json",
    displayName: "S&P 500",
    url: "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies",
  },
  {
    file: "sp400.json",
    displayName: "S&P 400 Mid Cap",
    url: "https://en.wikipedia.org/wiki/List_of_S%26P_400_companies",
  },
  {
    file: "sp600.json",
    displayName: "S&P 600 Small Cap",
    url: "https://en.wikipedia.org/wiki/List_of_S%26P_600_companies",
  },
  {
    file: "nasdaq100.json",
    displayName: "NASDAQ 100",
    url: "https://en.wikipedia.org/wiki/Nasdaq-100",
  },
  {
    file: "fmp-stocks.json",
    displayName: "FMP Global Stocks",
    url: "https://financialmodelingprep.com/api/v3/stock/list",
  },
  {
    file: "fmp-etfs.json",
    displayName: "FMP ETFs",
    url: "https://financialmodelingprep.com/api/v3/etf/list",
  },
];

function loadJson(filePath: string): JsonData | null {
  if (!existsSync(filePath)) {
    return null;
  }
  const content = readFileSync(filePath, "utf-8");
  return JSON.parse(content);
}

function escapeRustString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function main() {
  const dataDir = join(__dirname, "..", "data", "reserved");

  // Collect all unique symbols
  const allSymbols = new Set<string>();
  const sourceStats: Array<{
    name: string;
    url: string;
    fetchedAt: string;
    total: number;
    unique: number;
  }> = [];

  console.log("\n=== Loading Reserved Symbol Sources ===\n");

  for (const source of SOURCES) {
    const filePath = join(dataDir, source.file);
    const data = loadJson(filePath);

    if (!data) {
      console.log(`  ⚠ Skipping ${source.file} (not found)`);
      continue;
    }

    const beforeCount = allSymbols.size;

    for (const item of data.symbols) {
      const symbol = item.symbol.toUpperCase().trim();
      if (symbol && symbol.length <= 10 && /^[A-Z0-9]+$/.test(symbol)) {
        allSymbols.add(symbol);
      }
    }

    const uniqueAdded = allSymbols.size - beforeCount;

    sourceStats.push({
      name: source.displayName,
      url: data.source || source.url,
      fetchedAt: data.fetchedAt,
      total: data.symbols.length,
      unique: uniqueAdded,
    });

    console.log(
      `  ✓ ${source.displayName}: ${data.symbols.length} total, ${uniqueAdded} unique added`
    );
  }

  console.log(`\n  Total unique symbols: ${allSymbols.size}\n`);

  // Generate Rust code
  const sortedSymbols = Array.from(allSymbols).sort();

  let rustCode = `//! Auto-generated reserved TradFi symbols
//!
//! Generated: ${new Date().toISOString()}
//!
//! These symbols are reserved for traditional finance assets and cannot be
//! registered by users. They are blocked to prevent ticker squatting on
//! stock symbols, ETFs, and other securities.
//!
//! Total unique symbols: ${allSymbols.size}
//!
//! Sources (merged and deduplicated):
`;

  // Add source documentation
  for (const stat of sourceStats) {
    rustCode += `//!   - ${stat.name}: ${stat.total} total, ${stat.unique} unique\n`;
    rustCode += `//!     URL: ${stat.url}\n`;
    rustCode += `//!     Fetched: ${stat.fetchedAt}\n`;
  }

  rustCode += `//!
//! DO NOT EDIT MANUALLY - regenerate with: npm run generate:reserved

use phf::phf_set;

/// Reserved TradFi symbols - stocks, ETFs, and other securities
/// These cannot be registered until Phase 3 (RWA tokenization)
pub static RESERVED_TRADFI: phf::Set<&'static str> = phf_set! {
`;

  // Add all symbols
  for (const symbol of sortedSymbols) {
    rustCode += `    "${escapeRustString(symbol)}",\n`;
  }

  rustCode += `};

/// Total number of reserved TradFi symbols
pub const RESERVED_TRADFI_COUNT: usize = ${allSymbols.size};

/// Check if a symbol is reserved for TradFi
#[inline]
pub fn is_reserved_tradfi(symbol: &str) -> bool {
    let upper = symbol.to_uppercase();
    RESERVED_TRADFI.contains(upper.as_str())
}
`;

  // Write the Rust file
  const rustPath = join(
    __dirname,
    "../../programs/tns/src/symbol_status/reserved.rs"
  );
  writeFileSync(rustPath, rustCode);

  console.log(`=== Summary ===\n`);
  console.log(`  Generated: ${rustPath}`);
  console.log(`  Total symbols: ${allSymbols.size}`);
  console.log(
    `  Estimated size: ~${((sortedSymbols.join("").length + sortedSymbols.length * 10) / 1024).toFixed(0)} KB\n`
  );

  // Print source breakdown
  console.log(`  Source breakdown:`);
  for (const stat of sourceStats) {
    console.log(`    ${stat.name}: ${stat.unique} unique (${stat.total} total)`);
  }
}

main();
