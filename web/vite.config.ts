import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'

/**
 * Where the built app will be served from.
 *
 * Local dev and `npm run build` serve from the domain root, so the default is
 * `/`. A GitHub Pages project site serves at `https://<user>.github.io/tactistl/`,
 * so CI sets `BASE_PATH=/tactistl/` before building. Vite requires both the
 * leading and the trailing slash.
 *
 * This is not a `VITE_`-prefixed variable on purpose: it is a build-time
 * setting read here in Node, not something client code should be able to see.
 */
const base = process.env.BASE_PATH ?? '/'

// https://vite.dev/config/
export default defineConfig({
  base,
  plugins: [svelte()],
})
