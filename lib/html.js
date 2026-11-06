// Small HTML helpers. Every value placed in a page goes through esc().
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Wraps page content in the shared layout. */
export function layout({ title, body, script = false, extraScript = null }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} - Quick Tool Box</title>
<link rel="stylesheet" href="/static/style.css">
${script ? '<script src="/static/app.js" defer></script>' : ''}
${extraScript ? `<script src="${esc(extraScript)}" defer></script>` : ''}
</head>
<body>
<a class="skip" href="#main">Skip to main content</a>
<header>
<nav aria-label="Site"><ul class="nav"><li><a href="/">All tools</a></li><li><a href="/menus">Saved menus</a></li><li><a href="/forms">My forms</a></li><li><a href="/profile">Profile</a></li><li><a href="/status">Status</a></li></ul></nav>
</header>
<main id="main">
${body}
</main>
</body>
</html>`;
}
