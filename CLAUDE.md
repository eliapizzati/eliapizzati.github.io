# CLAUDE.md — eliapizzati.github.io

Working notes for Claude Code on this repo. Personal academic website for
**Elia Pizzati**, NHFP Einstein Fellow at the Center for Astrophysics | Harvard & Smithsonian
(previously Ph.D. at Leiden Observatory, ENIGMA group). Served via **GitHub Pages** at
`eliapizzati.github.io` — every push to `main` triggers a Jekyll build + deploy.

## Stack & structure (current — Jekyll, shipped 2026-05-31)

- **Jekyll** static site (GitHub Pages builds it server-side; no local build needed to deploy).
- Layout/includes: `_layouts/default.html`, `_includes/nav.html`, `_includes/footer.html`,
  config in `_config.yml`. Each page is a front-matter file (`layout: default`, `active:`,
  optional `mathjax: true`, `hero: large` for home, `heading:` for sub-page header band).
- Pages: `index.html` (hero + intro card + feature cards), `about_me.html`, `cv.html`
  (web CV + PDF download button), `research.html`, `publications.html`.
- **Publications are data-driven**: edit `_data/publications.yml` (3 lists: `first_author`,
  `second_third`, `contributing`; fields title/year/authors/venue/url/url_label, HTML+LaTeX
  allowed). `publications.html` renders them with a Liquid loop — don't hand-edit the list there.
- **Home hero** is fully generative (no photo): CSS starfield + nebula in `header.hero`
  (site.css) plus an SVG filament overlay `assets/cosmic-web.svg` (regenerate with the seeded
  Python snippet in git history if needed). Respects `prefers-reduced-motion`.
- `thesis_webpage/index.html` has a sticky "back to main site" bar and a featured full-thesis card.
- Styling: `assets/css/site.css` — custom design system (Inter font, apple-green theme,
  light/dark via `prefers-color-scheme`, glassmorphism cards). **No more jQuery / Arcana.**
  Font Awesome 5 via `assets/css/fontawesome-all.min.css` (+ `assets/webfonts/`). SVG favicon
  at `assets/favicon.svg`.
- `thesis_webpage/` is a separate self-contained page (same design language); site.css mirrors it.
- `documents/CV_Elia_Pizzati_website.pdf` — linked CV. `images/` — figures + photos (~3.5 MB
  after cleanup/compression).

### Gotchas
- Nav + footer now live in ONE place each (`_includes/`). Edit there, not per page.
- `cv.html` CV content is hand-maintained from the PDF CV — keep in sync when the PDF updates.
- Local full Jekyll build fails (system Ruby 2.6 too old; ffi/eventmachine need Ruby ≥3).
  GitHub Pages (Ruby 3.x) builds fine. To preview locally without Jekyll:
  `ruby /tmp/jekyll-verify/render.rb` → writes `_preview/` (gitignored), then
  `cd _preview && python3 -m http.server`. Scripts live in `/tmp/jekyll-verify/`.

## Conventions
- Match existing indentation (tabs). Content pages are front-matter + HTML using `.prose`,
  `.cards`/`.card`, `.intro`, `.about-grid`, `.pub-list`, `.research-figure`/`.research-text`.
- Keep author name **bold** in publication lists (`<b>Elia Pizzati</b>`).
- `mathjax: true` in front matter loads MathJax for `\(...\)` LaTeX (research/publications).
- Contact: institute `elia.pizzati@cfa.harvard.edu`, personal `elia.pizzati@gmail.com`.
- Canonical links: ORCID `0000-0002-9712-0038`, Google Scholar user `Pl10rQoAAAAJ`,
  ADS author "Pizzati, Elia", GitHub `eliapizzati`, LinkedIn `elia-pizzati-9a3731271`.
- Headline paper count is **21** (all listed, incl. submitted); 7 first-author. Update home
  + cv + publications lead together when it changes.

## Migration status (branch `jekyll-migration`)

**Shipped 2026-05-31** (merged to `main`, live, GitHub Pages build verified): full Jekyll
migration + redesign + content refresh + cleanup. All P0/P1/P2 items below are DONE — kept
for history. Verified by rendering pages through a pure-Ruby Liquid script (system Ruby 2.6
can't run full Jekyll; GitHub Pages Ruby 3.x builds fine) and by checking the live site.

### Done
- Jekyll: `_config.yml`, `_layouts/default.html`, `_includes/nav.html`+`footer.html`, `Gemfile`.
  All pages → front-matter + shared layout; new `cv.html`. Nav/footer in one place (drift fixed).
- Content: publications rebuilt from 2026 CV (7 first / 5 second–third / 9 contributing, 21 total);
  fixed stale Leiden email, 2024 copyright, typos; removed compromised `polyfill.io`.
- Design: custom `assets/css/site.css` (Inter, apple-green, light/dark, glassmorphism cards,
  hero, FA icons), SVG favicon, meta description + Open Graph. Arcana template fully removed.
- Cleanup: deleted `main.css`/`assets/js`/`assets/sass`/`two-sidebar.html`/`README.txt`/
  `LICENSE.txt`/`.idea`; removed/compressed images (19 MB → 3.5 MB). Added `.gitignore`.

### Future ideas (not started)
- A "News"/"Press" blurb (MIT News etc.) and/or a Talks/Seminars section from the CV.
- Convert remaining research figures to WebP; lazy-load images.
- Optional ADS API auto-fetch script to regenerate `_data/publications.yml`.

## How to preview locally
No Jekyll needed: `ruby /tmp/jekyll-verify/render.rb` → `_preview/` (gitignored), then
`cd _preview && python3 -m http.server`. With a modern Ruby: `bundle install && bundle exec jekyll serve`.
