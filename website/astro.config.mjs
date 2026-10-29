import starlight from "@astrojs/starlight";
import { defineConfig, passthroughImageService } from "astro/config";
import starlightLinksValidator from "starlight-links-validator";
import siteData from "./src/generated/site-data.json" with { type: "json" };

export default defineConfig({
  site: "https://agemon.korak-kurani.com",
  trailingSlash: "always",
  image: { service: passthroughImageService() },
  build: { inlineStylesheets: "never" },
  vite: { build: { assetsInlineLimit: 0 } },
  integrations: [
    starlight({
      title: "agemon",
      description: siteData.description,
      logo: {
        light: "./src/assets/brand/lockup-horizontal-light.svg",
        dark: "./src/assets/brand/lockup-horizontal-dark.svg",
        replacesTitle: true,
      },
      favicon: "/favicon.svg",
      head: [
        {
          tag: "link",
          attrs: { rel: "icon", href: "/favicon.ico", sizes: "48x48" },
        },
        {
          tag: "link",
          attrs: { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
        },
        {
          tag: "link",
          attrs: { rel: "manifest", href: "/site.webmanifest" },
        },
      ],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: `https://github.com/${siteData.repository}`,
        },
      ],
      customCss: ["./src/styles/theme.css"],
      sidebar: [
        { label: "Start", items: [{ autogenerate: { directory: "start" } }] },
        {
          label: "Reference",
          items: [{ autogenerate: { directory: "reference" } }],
        },
        {
          label: "Skill library",
          items: [{ autogenerate: { directory: "skills" } }],
        },
        {
          label: "Project",
          items: [{ autogenerate: { directory: "project" } }],
        },
      ],
      plugins: [starlightLinksValidator()],
    }),
  ],
});
