# peek docs site

Documentation for `peek` (the `agent-peek` npm package), built with
[Blume](https://useblume.dev). Deploys to https://peekc.li.

Content lives in `docs/` as MDX. Navigation order is set in `docs/meta.ts`, and
site config (branding, GitHub link, theme) is in `blume.config.ts`.

## Develop

```bash
npm install
npm run dev      # hot-reload dev server
```

## Build

```bash
npm run build    # static output to dist/
```

## Deploy

The build is static (`dist/`), so it deploys to any static host (Vercel,
Netlify, GitHub Pages, Cloudflare Pages). Set `deployment.site` in
`blume.config.ts` to your production URL to enable the sitemap and OG images.
