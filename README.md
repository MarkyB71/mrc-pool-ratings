# MRC Pool Ratings

Elo rating ladder for the MRC pool club: enter results, and ratings, divisions, the league table, head-to-heads and stats update automatically.

## Files
- `index.html` – the page
- `app.js` – rating engine and screens
- `api.php` – saves players and results to `data/ladder.json` (created automatically, never committed)

## Hosting
Needs any web host with PHP 7.4+. Copy these files into a folder on the site, e.g. `public_html/pool/`.
The first person to click **Admin login** creates the admin PIN, so do that straight after uploading.
Daily backups are written to `data/backup-YYYY-MM-DD.json`.
