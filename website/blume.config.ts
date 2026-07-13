import { defineConfig } from "blume";

export default defineConfig({
  title: "peek",
  description:
    "The context feed your agents read before touching the repo. Plus read-only visibility into every local agent session.",

  logo: {
    text: "peek",
    href: "/",
  },

  github: {
    owner: "akhileshrangani4",
    repo: "agent-peek",
    branch: "main",
  },

  theme: {
    accent: "teal",
    radius: "md",
    mode: "system",
  },

  navigation: {
    repo: true,
    featured: [
      { label: "npm", href: "https://www.npmjs.com/package/agent-peek", icon: "package" },
      { label: "GitHub", href: "https://github.com/akhileshrangani4/agent-peek", icon: "github" },
    ],
  },

  content: {
    root: "docs",
  },

  deployment: {
    site: "https://peekc.li",
  },

  seo: {
    x: {
      handle: "@akhileshrangani",
      creator: "@akhileshrangani",
    },
  },
});
