// The Settings categories, in sidebar order: used by the navigation and the Settings index.

export const settingsCategories = [
  {
    to: "/settings/languages",
    label: "Languages",
    description: "Root folders, indexers and Komga library for each language.",
  },
  {
    to: "/settings/indexers",
    label: "Indexers",
    description: "Prowlarr, which searches the indexers each language uses.",
  },
  {
    to: "/settings/download-clients",
    label: "Download Clients",
    description: "qBittorrent: category and how often downloads are checked.",
  },
  {
    to: "/settings/connect",
    label: "Connect",
    description: "Komga, rescanned after each import.",
  },
  {
    to: "/settings/metadata",
    label: "Metadata",
    description: "The Manga-News dataset for French publishers and volume counts.",
  },
  {
    to: "/settings/general",
    label: "General",
    description: "The mangarr API key and your password.",
  },
] as const;

export type SettingsPath = (typeof settingsCategories)[number]["to"];
