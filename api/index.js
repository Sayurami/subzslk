import fetch from "node-fetch";
import * as cheerio from "cheerio";

async function axiosGet(url, options = {}) {
  const res = await fetch(url, { headers: options.headers || {} });
  const data = await res.text();
  return { data };
}

const BASE_URL = "https://www.moviesublk.com";

const headers = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: BASE_URL,
};

export default async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const { action, query, url, page = "1" } = req.query;

    if (!action)
      return res.status(400).json({ status: false, message: "action missing. Use: search | list | details | gdrive" });

    // ─────────────────────────────────────────────
    // 1. SEARCH  →  /api?action=search&query=solo+leveling
    // ─────────────────────────────────────────────
    if (action === "search") {
      if (!query) return res.status(400).json({ status: false, message: "query param missing" });

      const searchUrl = `${BASE_URL}/search?q=${encodeURIComponent(query)}`;
      const { data } = await axiosGet(searchUrl, { headers });
      const $ = cheerio.load(data);
      const results = [];

      // moviesublk uses Blogger – posts listed as .blog-posts .post
      $(".blog-posts .post, article, .post-outer").each((i, el) => {
        const title =
          $(el).find(".post-title a, h2 a, h3 a").first().text().trim() ||
          $(el).find("a").first().attr("title") ||
          "";
        const link = $(el).find(".post-title a, h2 a, h3 a").first().attr("href") || $(el).find("a").first().attr("href") || "";
        const image = $(el).find("img").first().attr("src") || $(el).find("img").first().attr("data-src") || "";
        if (title && link) results.push({ title, link, image });
      });

      return res.json({ status: true, count: results.length, results });
    }

    // ─────────────────────────────────────────────
    // 2. LIST (new / by year)  →  /api?action=list&page=1  OR  /api?action=list&query=2026&page=1
    // ─────────────────────────────────────────────
    if (action === "list") {
      const listUrl = query
        ? `${BASE_URL}/p/1.html?q=${encodeURIComponent(query)}&m=1`
        : `${BASE_URL}/p/1.html?q=New&m=1`;

      const { data } = await axiosGet(listUrl, { headers });
      const $ = cheerio.load(data);
      const results = [];

      $("article, .post-outer, .blog-posts .post").each((i, el) => {
        const title = $(el).find(".post-title a, h2 a, h3 a").first().text().trim() || "";
        const link = $(el).find(".post-title a, h2 a, h3 a").first().attr("href") || $(el).find("a").first().attr("href") || "";
        const image = $(el).find("img").first().attr("src") || $(el).find("img").first().attr("data-src") || "";
        const badge = $(el).find(".label, .post-labels a").first().text().trim();
        if (title && link) results.push({ title, link, image, type: badge || "MOVIE" });
      });

      return res.json({ status: true, count: results.length, results });
    }

    // ─────────────────────────────────────────────
    // 3. DETAILS  →  /api?action=details&url=<full post url>
    //    Returns: title, image, type (movie/series/anime), episodes[] or gdrive_links[]
    // ─────────────────────────────────────────────
    if (action === "details") {
      if (!url) return res.status(400).json({ status: false, message: "url param missing" });

      const { data } = await axiosGet(url, { headers });
      const $ = cheerio.load(data);

      const title = $("h1.post-title, h2.post-title, h1").first().text().trim();
      const image = $(".post-body img, .separator img").first().attr("src") || $(".post-body img").first().attr("data-src") || "";

      // Detect episodes – look for ep-N anchor pattern or episode buttons
      const episodes = [];
      $("a[id^='ep-'], a[href*='#ep-']").each((i, el) => {
        const epId = $(el).attr("id") || $(el).attr("href") || "";
        const epNum = epId.replace(/.*ep-/, "ep-");
        const epTitle = $(el).text().trim();
        episodes.push({ ep: epNum, title: epTitle, anchor: `${url}#${epId.replace("#", "")}` });
      });

      // Collect all Google Drive links directly on the page
      const gdriveLinks = extractGdriveLinks($, data);

      return res.json({
        status: true,
        title,
        image,
        url,
        has_episodes: episodes.length > 0,
        episodes: episodes.length > 0 ? episodes : null,
        gdrive_links: gdriveLinks.length > 0 ? gdriveLinks : null,
      });
    }

    // ─────────────────────────────────────────────
    // 4. GDRIVE  →  /api?action=gdrive&url=<post or episode url>
    //    Scrapes page → finds ALL Google Drive links → returns direct download URLs
    // ─────────────────────────────────────────────
    if (action === "gdrive") {
      if (!url) return res.status(400).json({ status: false, message: "url param missing" });

      const { data } = await axiosGet(url, { headers });
      const $ = cheerio.load(data);
      const gdriveLinks = extractGdriveLinks($, data);

      if (gdriveLinks.length === 0) {
        return res.json({ status: false, message: "No Google Drive links found on this page", url });
      }

      return res.json({ status: true, count: gdriveLinks.length, gdrive_links: gdriveLinks });
    }

    return res.status(400).json({ status: false, message: `Unknown action: ${action}` });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ status: false, error: err.message });
  }
}

// ─── Helper: extract & normalise all Google Drive links from a page ───────────
function extractGdriveLinks($, rawHtml) {
  const found = [];
  const seen = new Set();

  // Pattern 1: anchor tags pointing to drive.google.com
  $("a[href*='drive.google.com'], a[href*='drive.usercontent.google.com']").each((i, el) => {
    const href = $(el).attr("href") || "";
    const label = $(el).text().trim() || "Google Drive";
    if (href && !seen.has(href)) {
      seen.add(href);
      found.push({ label, original: href, direct: toDirect(href) });
    }
  });

  // Pattern 2: raw URLs in HTML (inside onclick, data-href, scripts, etc.)
  const re = /https:\/\/drive\.google\.com\/[^\s"'<>]+/g;
  const matches = rawHtml.match(re) || [];
  for (const m of matches) {
    const clean = m.replace(/\\u003d/g, "=").replace(/\\u0026/g, "&").split("&amp;")[0];
    if (!seen.has(clean)) {
      seen.add(clean);
      found.push({ label: "Google Drive", original: clean, direct: toDirect(clean) });
    }
  }

  return found;
}

// Convert any drive.google.com share/view URL → direct usercontent download URL
function toDirect(url) {
  // Already a direct link
  if (url.includes("drive.usercontent.google.com")) return url;

  // /file/d/<ID>/view  or  /open?id=<ID>
  const idMatch =
    url.match(/\/file\/d\/([a-zA-Z0-9_-]{10,})/) ||
    url.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);

  if (idMatch) {
    return `https://drive.usercontent.google.com/download?id=${idMatch[1]}&export=download&authuser=0`;
  }
  return url; // return as-is if we can't parse it
}
