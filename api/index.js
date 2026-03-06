const fetch = require("node-fetch");
const cheerio = require("cheerio");

const BASE_URL = "https://www.moviesublk.com";
const headers = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: BASE_URL,
};

async function getHTML(url) {
  const res = await fetch(url, { headers });
  return await res.text();
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const { action, query, url } = req.query;

    if (!action)
      return res.status(400).json({ status: false, message: "action missing. Use: search | list | details | gdrive" });

    if (action === "search") {
      if (!query) return res.status(400).json({ status: false, message: "query param missing" });
      const html = await getHTML(`${BASE_URL}/search?q=${encodeURIComponent(query)}`);
      const $ = cheerio.load(html);
      const results = [];
      $(".blog-posts .post, article, .post-outer").each((i, el) => {
        const title = $(el).find(".post-title a, h2 a, h3 a").first().text().trim();
        const link = $(el).find(".post-title a, h2 a, h3 a").first().attr("href") || $(el).find("a").first().attr("href");
        const image = $(el).find("img").first().attr("src") || $(el).find("img").first().attr("data-src") || "";
        if (title && link) results.push({ title, link, image });
      });
      return res.json({ status: true, count: results.length, results });
    }

    if (action === "list") {
      const listUrl = query
        ? `${BASE_URL}/p/1.html?q=${encodeURIComponent(query)}&m=1`
        : `${BASE_URL}/p/1.html?q=New&m=1`;
      const html = await getHTML(listUrl);
      const $ = cheerio.load(html);
      const results = [];
      $("article, .post-outer, .blog-posts .post").each((i, el) => {
        const title = $(el).find(".post-title a, h2 a, h3 a").first().text().trim();
        const link = $(el).find(".post-title a, h2 a, h3 a").first().attr("href") || $(el).find("a").first().attr("href");
        const image = $(el).find("img").first().attr("src") || $(el).find("img").first().attr("data-src") || "";
        const badge = $(el).find(".label, .post-labels a").first().text().trim();
        if (title && link) results.push({ title, link, image, type: badge || "MOVIE" });
      });
      return res.json({ status: true, count: results.length, results });
    }

    if (action === "details") {
      if (!url) return res.status(400).json({ status: false, message: "url param missing" });
      const html = await getHTML(url);
      const $ = cheerio.load(html);
      const title = $("h1.post-title, h2.post-title, h1").first().text().trim();
      const image = $(".post-body img, .separator img").first().attr("src") || "";
      const episodes = [];
      $("a[id^='ep-']").each((i, el) => {
        const epId = $(el).attr("id") || "";
        episodes.push({ ep: epId, anchor: `${url}#${epId}` });
      });
      const gdriveLinks = extractGdriveLinks($, html);
      return res.json({ status: true, title, image, url, has_episodes: episodes.length > 0, episodes: episodes.length > 0 ? episodes : null, gdrive_links: gdriveLinks.length > 0 ? gdriveLinks : null });
    }

    if (action === "gdrive") {
      if (!url) return res.status(400).json({ status: false, message: "url param missing" });
      const html = await getHTML(url);
      const $ = cheerio.load(html);
      const gdriveLinks = extractGdriveLinks($, html);
      if (gdriveLinks.length === 0)
        return res.json({ status: false, message: "No Google Drive links found", url });
      return res.json({ status: true, count: gdriveLinks.length, gdrive_links: gdriveLinks });
    }

    return res.status(400).json({ status: false, message: `Unknown action: ${action}` });
  } catch (err) {
    return res.status(500).json({ status: false, error: err.message });
  }
};

function extractGdriveLinks($, rawHtml) {
  const found = [];
  const seen = new Set();
  $("a[href*='drive.google.com'], a[href*='drive.usercontent.google.com']").each((i, el) => {
    const href = $(el).attr("href") || "";
    const label = $(el).text().trim() || "Google Drive";
    if (href && !seen.has(href)) {
      seen.add(href);
      found.push({ label, original: href, direct: toDirect(href) });
    }
  });
  const matches = rawHtml.match(/https:\/\/drive\.google\.com\/[^\s"'<>]+/g) || [];
  for (const m of matches) {
    const clean = m.replace(/\\u003d/g, "=").replace(/\\u0026/g, "&").split("&amp;")[0];
    if (!seen.has(clean)) {
      seen.add(clean);
      found.push({ label: "Google Drive", original: clean, direct: toDirect(clean) });
    }
  }
  return found;
}

function toDirect(url) {
  if (url.includes("drive.usercontent.google.com")) return url;
  const idMatch = url.match(/\/file\/d\/([a-zA-Z0-9_-]{10,})/) || url.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  if (idMatch) return `https://drive.usercontent.google.com/download?id=${idMatch[1]}&export=download&authuser=0`;
  return url;
}
