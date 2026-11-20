/**
 * Social banners only: brand-kit/social/*-{light,dark}.png (X header, LinkedIn,
 * Facebook, YouTube, OG image, avatar) and brand-kit/web/og-image.png. The
 * layouts live in render-brand.mjs; this is a shortcut for that one step.
 *
 * Usage: node tools/icons/render-social.mjs   (BRAVE_PATH / SITR_CHROME pick the browser)
 */
process.argv.splice(2, process.argv.length - 2, "social");
await import("./render-brand.mjs");
