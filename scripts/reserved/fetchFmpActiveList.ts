/**
 * Fetch all actively trading US securities from Financial Modeling Prep API
 *
 * This provides a comprehensive list of all tradable US securities,
 * which we use as the base for reserved TradFi symbols.
 */

import axios from "axios";
import { FmpAsset } from "./types";

const FMP_BASE_URL = "https://financialmodelingprep.com/api/v3";

// US exchanges we care about
const US_EXCHANGES = new Set([
  "NYSE",
  "NASDAQ",
  "AMEX",
  "NYSEArca",
  "BATS",
  "NYSE MKT",
  "NMS", // NASDAQ Global Select Market
  "NGS", // NASDAQ Global Market
  "NCM", // NASDAQ Capital Market
]);

export async function fetchFmpActiveList(apiKey: string): Promise<FmpAsset[]> {
  console.log("Fetching actively trading list from FMP...");

  const response = await axios.get(
    `${FMP_BASE_URL}/available-traded/list?apikey=${apiKey}`
  );

  const allAssets: FmpAsset[] = response.data;
  console.log(`  Total assets from FMP: ${allAssets.length}`);

  // Filter to US exchanges only
  const usAssets = allAssets.filter((asset) => {
    const exchange = asset.exchangeShortName || asset.exchange;
    return US_EXCHANGES.has(exchange);
  });

  console.log(`  US exchange assets: ${usAssets.length}`);

  // Filter to stocks only (exclude ETFs, funds, etc. - we may add those separately)
  const usStocks = usAssets.filter((asset) => asset.type === "stock");
  console.log(`  US stocks only: ${usStocks.length}`);

  return usStocks;
}

export async function fetchFmpAllAssets(apiKey: string): Promise<FmpAsset[]> {
  console.log("Fetching complete stock list from FMP (all global markets)...");

  const response = await axios.get(
    `${FMP_BASE_URL}/stock/list?apikey=${apiKey}`
  );

  const allAssets: FmpAsset[] = response.data;
  console.log(`  Total assets from FMP: ${allAssets.length}`);

  return allAssets;
}

export async function fetchFmpEtfList(apiKey: string): Promise<FmpAsset[]> {
  console.log("Fetching ETF list from FMP (all global markets)...");

  const response = await axios.get(`${FMP_BASE_URL}/etf/list?apikey=${apiKey}`);

  const allEtfs: FmpAsset[] = response.data;
  console.log(`  Total ETFs from FMP: ${allEtfs.length}`);

  return allEtfs;
}
