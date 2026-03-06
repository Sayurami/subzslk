# moviesublk.com Scraper API

Vercel serverless API to scrape moviesublk.com — search, list, get details, and extract Google Drive download links.

---

## 🚀 Deploy to Vercel

```bash
npm i -g vercel
vercel login
vercel --prod
```

---

## 📡 API Endpoints

All requests go to: `https://your-project.vercel.app/api`

### 1. Search
```
GET /api?action=search&query=solo+leveling
```

### 2. List (New / By Year)
```
GET /api?action=list
GET /api?action=list&query=2026
```

### 3. Details (Movie or Series page)
```
GET /api?action=details&url=https://www.moviesublk.com/2026/02/the-raja-saab-2026-sinhala-osubtitles.html
```
Returns: title, image, episodes (if series), gdrive_links (if movie)

### 4. Get Google Drive Links
```
GET /api?action=gdrive&url=https://www.moviesublk.com/2026/02/l-l-2026-sinhala-subtitles-ai.html?m=1#ep-1
```
Returns all G-Drive links + direct download URLs from that page/episode.

---

## 📦 Response Format

### gdrive response
```json
{
  "status": true,
  "count": 1,
  "gdrive_links": [
    {
      "label": "G-Drive",
      "original": "https://drive.google.com/file/d/XXXX/view",
      "direct": "https://drive.usercontent.google.com/download?id=XXXX&export=download&authuser=0"
    }
  ]
}
```
