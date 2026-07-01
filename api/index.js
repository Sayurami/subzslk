const fetch = require("node-fetch");
const cheerio = require("cheerio");

const SCRAPER_KEY = "870f1e70c44557408c43a180ab4c78b2";

const SITES = {
  movie: "https://www.moviesublk.com",
  anime: "https://www.animesublk.com",
};

// Proxy a URL through ScraperAPI to bypass IP blocks
function scraperUrl(target) {
  return `http://api.scraperapi.com?api_key=${SCRAPER_KEY}&url=${encodeURIComponent(target)}`;
}

// Fetch JSON from the Blogger feed API via ScraperAPI
async function getFeed(baseUrl, params) {
  const feedUrl = `${baseUrl}/feeds/posts/default`;
  const qs = new URLSearchParams({ alt: "json", "max-results": "20", ...params });
  const res = await fetch(scraperUrl(`${feedUrl}?${qs}`));
  if (!res.ok) throw new Error(`Feed error: ${res.status}`);
  return res.json();
}

// Fetch a label-based feed via ScraperAPI
async function getLabelFeed(baseUrl, label) {
  const feedUrl = `${baseUrl}/feeds/posts/default/-/${encodeURIComponent(label)}`;
  const qs = new URLSearchParams({ alt: "json", "max-results": "20" });
  const res = await fetch(scraperUrl(`${feedUrl}?${qs}`));
  if (!res.ok) throw new Error(`Feed error: ${res.status}`);
  return res.json();
}

// Fetch HTML of a specific post page via ScraperAPI
async function getHTML(url) {
  const res = await fetch(scraperUrl(url));
  if (!res.ok) throw new Error(`HTTP error: ${res.status}`);
  return res.text();
}

// Convert a Blogger feed entry to a result item
function entryToItem(entry) {
  const title = entry.title.$t || "";
  const link = (entry.link.find((l) => l.rel === "alternate") || {}).href || "";
  const rawThumb = (entry.media$thumbnail || {}).url || "";
  const image = rawThumb.replace(/\/s\d+-c\//, "/s320/");
  const type = (entry.category || []).map((c) => c.term).join(", ") || null;
  return { title, link, image, type };
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const { action, query, url, site = "movie" } = req.query;

    // Validate site param
    if (!SITES[site]) {
      return res.status(400).json({
        status: false,
        message: `Invalid site. Use: ${Object.keys(SITES).join(" | ")}`,
      });
    }

    const BASE_URL = SITES[site];

    if (!action) {
      return res.status(400).json({
        status: false,
        message: "action missing. Use: search | list | details | gdrive",
        sites: Object.keys(SITES),
      });
    }

    // ── SEARCH ───────────────────────────────────────────────────────────────
    if (action === "search") {
      if (!query)
        return res.status(400).json({ status: false, message: "query param missing" });

      const data = await getFeed(BASE_URL, { q: query });
      const entries = data.feed.entry || [];
      const results = entries.map(entryToItem).filter((r) => r.title && r.link);
      return res.json({ status: true, site, count: results.length, results });
    }

    // ── LIST ─────────────────────────────────────────────────────────────────
    if (action === "list") {
      let data;
      if (query) {
        data = await getLabelFeed(BASE_URL, query);
      } else {
        data = await getFeed(BASE_URL, {});
      }
      const entries = data.feed.entry || [];
      const results = entries.map(entryToItem).filter((r) => r.title && r.link);
      return res.json({ status: true, site, count: results.length, results });
    }

    // ── DETAILS ──────────────────────────────────────────────────────────────
    if (action === "details") {
      if (!url)
        return res.status(400).json({ status: false, message: "url param missing" });

      const html = await getHTML(url);
      const $ = cheerio.load(html);

      const title = $("h1.post-title, h2.post-title, h1.entry-title, h2.entry-title, h1")
        .first()
        .text()
        .trim();

      let image = "";
      $(".post-body img, .entry-content img").each((i, el) => {
        const src = $(el).attr("src") || $(el).attr("data-src") || "";
        if (src && !image) image = src;
      });

      // Episodes: elements with id starting with "ep-" (skip "ep-grid")
      const episodes = [];
      $('[id^="ep-"]').each((i, el) => {
        const epId = $(el).attr("id") || "";
        if (epId && epId !== "ep-grid") {
          episodes.push({ ep: epId, anchor: `${url.split("#")[0]}#${epId}` });
        }
      });

      const gdriveLinks = extractGdriveLinks($, html);

      return res.json({
        status: true,
        site,
        title,
        image,
        url,
        has_episodes: episodes.length > 0,
        episodes: episodes.length > 0 ? episodes : null,
        gdrive_links: gdriveLinks.length > 0 ? gdriveLinks : null,
      });
    }

    // ── GDRIVE ───────────────────────────────────────────────────────────────
    if (action === "gdrive") {
      if (!url)
        return res.status(400).json({ status: false, message: "url param missing" });

      const html = await getHTML(url);
      const $ = cheerio.load(html);
      const gdriveLinks = extractGdriveLinks($, html);

      if (gdriveLinks.length === 0)
        return res.json({ status: false, message: "No Google Drive links found", url });

      return res.json({ status: true, site, count: gdriveLinks.length, gdrive_links: gdriveLinks });
    }

    return res.status(400).json({ status: false, message: `Unknown action: ${action}` });
  } catch (err) {
    return res.status(500).json({ status: false, error: err.message });
  }
};

function extractGdriveLinks($, rawHtml) {
  const found = [];
  const seen = new Set();

  $('a[href*="drive.google.com"], a[href*="drive.usercontent.google.com"]').each((i, el) => {
    const href = $(el).attr("href") || "";
    const label = $(el).text().trim() || "Google Drive";
    if (href && !seen.has(href)) {
      seen.add(href);
      found.push({ label, original: href, direct: toDirect(href) });
    }
  });

  const matches = rawHtml.match(/https:\/\/drive\.google\.com\/[^\s"'<>\\]+/g) || [];
  for (const m of matches) {
    const clean = m
      .replace(/\\u003d/g, "=")
      .replace(/\\u0026/g, "&")
      .split("&amp;")[0];
    if (!seen.has(clean)) {
      seen.add(clean);
      found.push({ label: "Google Drive", original: clean, direct: toDirect(clean) });
    }
  }

  return found;
}

function toDirect(url) {
  if (url.includes("drive.usercontent.google.com")) return url;
  const idMatch =
    url.match(/\/file\/d\/([a-zA-Z0-9_-]{10,})/) ||
    url.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  if (idMatch)
    return `https://drive.usercontent.google.com/download?id=${idMatch[1]}&export=download&authuser=0`;
  return url;
}
