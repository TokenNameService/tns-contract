import { WikiAsset } from "../types";
import * as cheerio from "cheerio";
import axios from "axios";

export const getDow = async (): Promise<WikiAsset[]> => {
  const response = await axios.get(
    "https://en.wikipedia.org/wiki/Dow_Jones_Industrial_Average",
    {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; TNSScraper/1.0)",
      },
    }
  );
  const $ = cheerio.load(response.data);

  const table = $("#constituents").closest("table");

  const companies: WikiAsset[] = [];
  table.find("tbody tr").each((index, element) => {
    if (index === 0) return;

    // DOW table structure: <th>Company</th><td>Exchange</td><td>Symbol</td><td>Industry</td>...
    const companyName = $(element).find("th").text().trim();
    const tds = $(element)
      .find("td")
      .map((_i, el) => $(el).text().trim())
      .get();

    if (tds.length >= 3) {
      companies.push({
        symbol: tds[1],
        name: companyName,
        sector: tds[2],
        industry: tds[2],
      });
    }
  });

  return companies;
};
