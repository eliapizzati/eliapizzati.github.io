# CLAUDE.md — eliapizzati.github.io

Working notes for Claude Code on this repo. Personal academic website for
**Elia Pizzati**, NHFP Einstein Fellow at the Center for Astrophysics | Harvard & Smithsonian
(previously Ph.D. at Leiden Observatory, ENIGMA group). Served via **GitHub Pages** at
`eliapizzati.github.io` — every push to `main` deploys live. There is no build step.

## Stack & structure

- Static HTML + CSS + jQuery. No framework, no bundler, no package manager.
- Main site is the **HTML5 UP "Arcana"** template (CCA 3.0). Styling: `assets/css/main.css`
  (compiled from `assets/sass/main.scss`). JS in `assets/js/` (jQuery + template helpers).
- Pages: `index.html`, `about_me.html`, `research.html`, `publications.html`.
- `thesis_webpage/` is a **separate, hand-built modern page** (Inter font, CSS custom
  properties, dark-mode via `prefers-color-scheme`, apple-green theme). It does NOT share
  the Arcana stylesheet — different design language from the rest of the site.
- `documents/CV_Elia_Pizzati_website.pdf` — linked CV. `images/` — figures + photos (~19 MB).

### Gotchas
- Nav bar and footer are **hard-copied into every page**. A change (e.g. email) must be made
  in all 4 pages or they drift out of sync. This is the #1 source of staleness here.
- `about_me.html`, `research.html`, `publications.html` open with `<head>` directly — they are
  missing the `<!DOCTYPE>`/`<html>`/`<body>` wrapper that `index.html` has. Browsers tolerate it
  but it's invalid HTML.
- Pages carry large blocks of commented-out template cruft (Lorem ipsum, unused sidebars).

## Conventions
- Match the existing page's indentation (tabs) and inline-style approach when editing Arcana pages.
- Keep author name **bold** in publication lists (`<b>Elia Pizzati</b>`).
- MathJax is loaded on `research.html`/`publications.html` for `\(...\)` LaTeX in text.
- Contact: institute `elia.pizzati@cfa.harvard.edu`, personal `elia.pizzati@gmail.com`.
- Canonical links: ORCID `0000-0002-9712-0038`, Google Scholar user `Pl10rQoAAAAJ`,
  ADS author "Pizzati, Elia", GitHub `eliapizzati`, LinkedIn `elia-pizzati-9a3731271`.

## Migration status (branch `jekyll-migration`)

The site is being migrated to Jekyll. **Done so far** (verified by rendering pages
through a pure-Ruby Liquid script — system Ruby 2.6 is too old to run full Jekyll
locally; GitHub Pages runs Ruby 3.x and builds the `github-pages` Gemfile fine):
- `_config.yml`, `_layouts/default.html`, `_includes/nav.html`, `_includes/footer.html`, `Gemfile`.
- All pages converted to front-matter + shared layout: `index`, `about_me`, `research`,
  `publications`, plus a NEW `cv.html` (web CV + PDF download button). Nav "CV" now → `cv.html`.
- Footer/email/nav now live in ONE place each (footer drift fixed permanently).
- Publications rebuilt from the 2026 CV: 7 first-author / 5 second–third / 9 contributing.
- Local preview: `ruby /tmp/jekyll-verify/render.rb` writes `_preview/` (gitignored); serve with
  `python3 -m http.server` from there. The render/verify scripts live in `/tmp/jekyll-verify/`.

**Open question:** home page + CV say "19 papers" (matches CV prose) but the list has 21 entries
(incl. 5 submitted). Confirm whether 19 = refereed-only and adjust the headline if needed.

**Remaining:** Phase C (visual refresh toward the `thesis_webpage` look), Phase D (meta/OG/favicon
already partly in the layout; still need favicon asset, image compression, delete dead files).

## Improvement backlog (proposed)

### P0 — correctness / quick wins (do first, low risk)
- [ ] Fix stale footers in `about_me.html`, `research.html`, `publications.html`: old Leiden email
      `pizzati@strw.leidenuniv.nl` → Harvard email; copyright `2024` → `2026`. (`index.html` already done.)
- [ ] Fix malformed `<p>…<p>` (unclosed) tags in the footers (e.g. `about_me.html:177-178`).
- [ ] Remove `polyfill.io` script from `publications.html` — compromised supply-chain domain, unused.
- [ ] Typos in `research.html`: "quassar"→"quasar", "ad galaxies"→"and galaxies",
      "quasar activity takes place"→"takes place".
- [ ] Update `publications.html`: refresh 2024 "submitted" entries to published status; add any
      2025–2026 papers. Verify the "18 publications / 7 first-author" count on `index.html` matches.

### P1 — SEO, sharing, polish
- [ ] Add `<meta name="description">`, Open Graph + Twitter card tags, and a favicon to every page
      (none exist today → ugly link previews, weak SEO).
- [ ] Optimize images: `background.png` is 7.5 MB, `banner*.jpg` ~3 MB each, `propic3.jpg` 2.1 MB.
      Resize/compress (target <300 KB each, use WebP) — biggest single perf win.
- [ ] Delete dead files: `two-sidebar.html`, `README.txt`, `images/*_old.png`, stray `.DS_Store`,
      and `.idea/` (add to `.gitignore`).
- [ ] Strip commented-out template cruft from the four main pages.

### P2 — structure / redesign (larger, discuss first)
- [ ] De-duplicate nav + footer (the root cause of footer drift). Options: a tiny JS include,
      Jekyll layouts/`_includes` (GitHub Pages supports Jekyll natively, still no local build needed),
      or a build step. Jekyll is the lowest-friction path for GitHub Pages.
- [ ] Decide visual direction: either (a) modernize the Arcana pages to match the polished
      `thesis_webpage` style (unify the site), or (b) keep Arcana but tidy it. Unifying is the
      higher-impact option.
- [ ] Consider a "News"/"Talks" section and a proper landing hero.

## How to preview locally
`python3 -m http.server 8000` from repo root, then open `http://localhost:8000`.
(Jekyll, if adopted: `bundle exec jekyll serve`.)
