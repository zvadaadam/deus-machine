// The curated Skills: Agent Skills folders at pinned commits, each checked
// (SKILL.md present, frontmatter name/description, license) when added.
// Installing fetches the folder at `source.ref` — moving a pin is a review.

import type { CatalogSkill } from "../types";

export const CATALOG_SKILLS: CatalogSkill[] = [
  {
    id: "anthropics-skills/frontend-design",
    name: "frontend-design",
    title: "Frontend design",
    description:
      "Distinctive, intentional visual design for new or reworked UI, so it never reads as a template.",
    categories: ["design", "developer"],
    publisher: "Anthropic",
    official: true,
    license: "Apache-2.0",
    source: {
      repo: "anthropics/skills",
      ref: "2c5958ecac7cee2b583967a2c4981d0f4a75c579",
      path: "skills/frontend-design",
    },
    requiresApps: [],
    homepage:
      "https://github.com/anthropics/skills/tree/2c5958ecac7cee2b583967a2c4981d0f4a75c579/skills/frontend-design",
  },
  {
    id: "anthropics-skills/canvas-design",
    name: "canvas-design",
    title: "Canvas design",
    description:
      "Create posters, art and other static visuals as PNG or PDF from a design philosophy.",
    categories: ["design", "creative"],
    publisher: "Anthropic",
    official: true,
    license: "Apache-2.0",
    source: {
      repo: "anthropics/skills",
      ref: "2c5958ecac7cee2b583967a2c4981d0f4a75c579",
      path: "skills/canvas-design",
    },
    requiresApps: [],
    homepage:
      "https://github.com/anthropics/skills/tree/2c5958ecac7cee2b583967a2c4981d0f4a75c579/skills/canvas-design",
  },
  {
    id: "anthropics-skills/algorithmic-art",
    name: "algorithmic-art",
    title: "Algorithmic art",
    description:
      "Generative art in p5.js with seeded randomness, flow fields and particle systems.",
    categories: ["creative"],
    publisher: "Anthropic",
    official: true,
    license: "Apache-2.0",
    source: {
      repo: "anthropics/skills",
      ref: "2c5958ecac7cee2b583967a2c4981d0f4a75c579",
      path: "skills/algorithmic-art",
    },
    requiresApps: [],
    homepage:
      "https://github.com/anthropics/skills/tree/2c5958ecac7cee2b583967a2c4981d0f4a75c579/skills/algorithmic-art",
  },
  {
    id: "anthropics-skills/webapp-testing",
    name: "webapp-testing",
    title: "Web app testing",
    description:
      "Test local web apps with Playwright: verify features, debug UI, capture screenshots and logs.",
    categories: ["developer"],
    publisher: "Anthropic",
    official: true,
    license: "Apache-2.0",
    source: {
      repo: "anthropics/skills",
      ref: "2c5958ecac7cee2b583967a2c4981d0f4a75c579",
      path: "skills/webapp-testing",
    },
    requiresApps: [],
    homepage:
      "https://github.com/anthropics/skills/tree/2c5958ecac7cee2b583967a2c4981d0f4a75c579/skills/webapp-testing",
  },
  {
    id: "anthropics-skills/mcp-builder",
    name: "mcp-builder",
    title: "MCP server builder",
    description:
      "Build high-quality MCP servers in Python or TypeScript that connect agents to external APIs.",
    categories: ["developer"],
    publisher: "Anthropic",
    official: true,
    license: "Apache-2.0",
    source: {
      repo: "anthropics/skills",
      ref: "2c5958ecac7cee2b583967a2c4981d0f4a75c579",
      path: "skills/mcp-builder",
    },
    requiresApps: [],
    homepage:
      "https://github.com/anthropics/skills/tree/2c5958ecac7cee2b583967a2c4981d0f4a75c579/skills/mcp-builder",
  },
  {
    id: "anthropics-skills/skill-creator",
    name: "skill-creator",
    title: "Skill creator",
    description:
      "Create, edit and evaluate skills, and tune their descriptions so they trigger reliably.",
    categories: ["developer", "productivity"],
    publisher: "Anthropic",
    official: true,
    license: "Apache-2.0",
    source: {
      repo: "anthropics/skills",
      ref: "2c5958ecac7cee2b583967a2c4981d0f4a75c579",
      path: "skills/skill-creator",
    },
    requiresApps: [],
    homepage:
      "https://github.com/anthropics/skills/tree/2c5958ecac7cee2b583967a2c4981d0f4a75c579/skills/skill-creator",
  },
  {
    id: "anthropics-skills/docx",
    name: "docx",
    title: "Word documents",
    description:
      "Create, read and edit Word documents with headings, tables, tracked changes and templates.",
    categories: ["documents", "writing"],
    publisher: "Anthropic",
    official: true,
    license: "Apache-2.0",
    source: {
      repo: "anthropics/skills",
      ref: "2c5958ecac7cee2b583967a2c4981d0f4a75c579",
      path: "skills/docx",
    },
    requiresApps: [],
    homepage:
      "https://github.com/anthropics/skills/tree/2c5958ecac7cee2b583967a2c4981d0f4a75c579/skills/docx",
  },
  {
    id: "anthropics-skills/pdf",
    name: "pdf",
    title: "PDF toolkit",
    description: "Read, merge, split, fill, watermark, OCR and create PDF files.",
    categories: ["documents"],
    publisher: "Anthropic",
    official: true,
    license: "Apache-2.0",
    source: {
      repo: "anthropics/skills",
      ref: "2c5958ecac7cee2b583967a2c4981d0f4a75c579",
      path: "skills/pdf",
    },
    requiresApps: [],
    homepage:
      "https://github.com/anthropics/skills/tree/2c5958ecac7cee2b583967a2c4981d0f4a75c579/skills/pdf",
  },
  {
    id: "anthropics-skills/pptx",
    name: "pptx",
    title: "PowerPoint decks",
    description: "Create, read and edit slide decks and pitch decks as .pptx files.",
    categories: ["documents"],
    publisher: "Anthropic",
    official: true,
    license: "Apache-2.0",
    source: {
      repo: "anthropics/skills",
      ref: "2c5958ecac7cee2b583967a2c4981d0f4a75c579",
      path: "skills/pptx",
    },
    requiresApps: [],
    homepage:
      "https://github.com/anthropics/skills/tree/2c5958ecac7cee2b583967a2c4981d0f4a75c579/skills/pptx",
  },
  {
    id: "anthropics-skills/xlsx",
    name: "xlsx",
    title: "Excel spreadsheets",
    description:
      "Open, clean, analyze and build spreadsheets with formulas, formatting and charts.",
    categories: ["documents", "data"],
    publisher: "Anthropic",
    official: true,
    license: "Apache-2.0",
    source: {
      repo: "anthropics/skills",
      ref: "2c5958ecac7cee2b583967a2c4981d0f4a75c579",
      path: "skills/xlsx",
    },
    requiresApps: [],
    homepage:
      "https://github.com/anthropics/skills/tree/2c5958ecac7cee2b583967a2c4981d0f4a75c579/skills/xlsx",
  },
  {
    id: "openai-skills/gh-fix-ci",
    name: "gh-fix-ci",
    title: "Fix failing CI",
    description:
      "Debug failing GitHub Actions checks on a PR with gh, then plan and apply a fix after approval.",
    categories: ["developer"],
    publisher: "OpenAI",
    official: true,
    license: "Apache-2.0",
    source: {
      repo: "openai/skills",
      ref: "49f948faa9258a0c61caceaf225e179651397431",
      path: "skills/.curated/gh-fix-ci",
    },
    requiresApps: [],
    homepage:
      "https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/gh-fix-ci",
  },
  {
    id: "openai-skills/security-best-practices",
    name: "security-best-practices",
    title: "Security best practices",
    description:
      "Security review and secure-by-default guidance for Python, JavaScript/TypeScript and Go code.",
    categories: ["developer"],
    publisher: "OpenAI",
    official: true,
    license: "Apache-2.0",
    source: {
      repo: "openai/skills",
      ref: "49f948faa9258a0c61caceaf225e179651397431",
      path: "skills/.curated/security-best-practices",
    },
    requiresApps: [],
    homepage:
      "https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/security-best-practices",
  },
  {
    id: "openai-skills/imagegen",
    name: "imagegen",
    title: "Image generation",
    description:
      "Generate or edit images (photos, illustrations, sprites, mockups) with OpenAI image models.",
    categories: ["creative", "design"],
    publisher: "OpenAI",
    official: true,
    license: "Apache-2.0",
    source: {
      repo: "openai/skills",
      ref: "49f948faa9258a0c61caceaf225e179651397431",
      path: "skills/.system/imagegen",
    },
    requiresApps: [],
    homepage:
      "https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431/skills/.system/imagegen",
  },
  {
    id: "openai-skills/linear",
    name: "linear",
    title: "Linear",
    description: "Read, create and update Linear issues, projects and team workflows.",
    categories: ["productivity"],
    publisher: "OpenAI",
    official: true,
    license: "Apache-2.0",
    source: {
      repo: "openai/skills",
      ref: "49f948faa9258a0c61caceaf225e179651397431",
      path: "skills/.curated/linear",
    },
    requiresApps: ["linear"],
    homepage:
      "https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/linear",
  },
  {
    id: "vercel-labs-agent-skills/vercel-react-best-practices",
    name: "vercel-react-best-practices",
    title: "React & Next.js best practices",
    description:
      "Vercel's React and Next.js performance rules for writing, reviewing and refactoring code.",
    categories: ["developer"],
    publisher: "Vercel",
    official: true,
    license: "MIT",
    source: {
      repo: "vercel-labs/agent-skills",
      ref: "1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62",
      path: "skills/react-best-practices",
    },
    requiresApps: [],
    homepage:
      "https://github.com/vercel-labs/agent-skills/tree/1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62/skills/react-best-practices",
  },
  {
    id: "vercel-labs-agent-skills/web-design-guidelines",
    name: "web-design-guidelines",
    title: "Web interface guidelines",
    description:
      "Review UI code against Vercel's Web Interface Guidelines for accessibility, UX and polish.",
    categories: ["design", "developer"],
    publisher: "Vercel",
    official: true,
    license: "MIT",
    source: {
      repo: "vercel-labs/agent-skills",
      ref: "1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62",
      path: "skills/web-design-guidelines",
    },
    requiresApps: [],
    homepage:
      "https://github.com/vercel-labs/agent-skills/tree/1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62/skills/web-design-guidelines",
  },
  {
    id: "vercel-labs-agent-skills/deploy-to-vercel",
    name: "deploy-to-vercel",
    title: "Deploy to Vercel",
    description: "Deploy apps and sites to Vercel and get a preview or production link.",
    categories: ["developer"],
    publisher: "Vercel",
    official: true,
    license: "MIT",
    source: {
      repo: "vercel-labs/agent-skills",
      ref: "1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62",
      path: "skills/deploy-to-vercel",
    },
    requiresApps: [],
    homepage:
      "https://github.com/vercel-labs/agent-skills/tree/1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62/skills/deploy-to-vercel",
  },
  {
    id: "vercel-labs-agent-skills/vercel-react-native-skills",
    name: "vercel-react-native-skills",
    title: "React Native best practices",
    description:
      "React Native and Expo performance practices: lists, animations and native modules.",
    categories: ["developer"],
    publisher: "Vercel",
    official: true,
    license: "MIT",
    source: {
      repo: "vercel-labs/agent-skills",
      ref: "1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62",
      path: "skills/react-native-skills",
    },
    requiresApps: [],
    homepage:
      "https://github.com/vercel-labs/agent-skills/tree/1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62/skills/react-native-skills",
  },
  {
    id: "vercel-labs-agent-browser/agent-browser",
    name: "agent-browser",
    title: "Agent browser",
    description:
      "Drive a real browser from the terminal: navigate, fill forms, click, screenshot and scrape.",
    categories: ["developer"],
    publisher: "Vercel",
    official: true,
    license: "Apache-2.0",
    source: {
      repo: "vercel-labs/agent-browser",
      ref: "4b0e9f01fa8d214d39bbfe5391257640634fb9a0",
      path: "skills/agent-browser",
    },
    requiresApps: [],
    homepage:
      "https://github.com/vercel-labs/agent-browser/tree/4b0e9f01fa8d214d39bbfe5391257640634fb9a0/skills/agent-browser",
  },
  {
    id: "obra-superpowers/brainstorming",
    name: "brainstorming",
    title: "Brainstorming",
    description:
      "Turn a rough idea into a validated design through questions before any code is written.",
    categories: ["developer", "productivity"],
    publisher: "Jesse Vincent (obra)",
    official: false,
    license: "MIT",
    source: {
      repo: "obra/superpowers",
      ref: "22f0b463e7a5e579904dd6211a520321035526f7",
      path: "skills/brainstorming",
    },
    requiresApps: [],
    homepage:
      "https://github.com/obra/superpowers/tree/22f0b463e7a5e579904dd6211a520321035526f7/skills/brainstorming",
  },
  {
    id: "obra-superpowers/systematic-debugging",
    name: "systematic-debugging",
    title: "Systematic debugging",
    description: "Find the root cause of a bug or failing test before proposing a fix.",
    categories: ["developer"],
    publisher: "Jesse Vincent (obra)",
    official: false,
    license: "MIT",
    source: {
      repo: "obra/superpowers",
      ref: "22f0b463e7a5e579904dd6211a520321035526f7",
      path: "skills/systematic-debugging",
    },
    requiresApps: [],
    homepage:
      "https://github.com/obra/superpowers/tree/22f0b463e7a5e579904dd6211a520321035526f7/skills/systematic-debugging",
  },
  {
    id: "mattpocock-skills/grilling",
    name: "grilling",
    title: "Grill me",
    description:
      "A relentless interview that stress-tests a plan, decision or idea until nothing is assumed.",
    categories: ["productivity", "developer"],
    publisher: "Matt Pocock",
    official: false,
    license: "MIT",
    source: {
      repo: "mattpocock/skills",
      ref: "4ae2317ddb22b046e26455e4f9c9b3aaaf62212d",
      path: "skills/productivity/grilling",
    },
    requiresApps: [],
    homepage:
      "https://github.com/mattpocock/skills/tree/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/productivity/grilling",
  },
  {
    id: "getsentry-skills/find-bugs",
    name: "find-bugs",
    title: "Find bugs",
    description:
      "Review the current branch's changes for bugs, security issues and code-quality problems.",
    categories: ["developer"],
    publisher: "Sentry",
    official: true,
    license: "Apache-2.0",
    source: {
      repo: "getsentry/skills",
      ref: "e94f22214528d69899d09c627b3315ddc3544816",
      path: "skills/find-bugs",
    },
    requiresApps: [],
    homepage:
      "https://github.com/getsentry/skills/tree/e94f22214528d69899d09c627b3315ddc3544816/skills/find-bugs",
  },
  {
    id: "upstash-context7/find-docs",
    name: "find-docs",
    title: "Up-to-date docs (Context7)",
    description: "Fetch current documentation and code examples for any library, framework or CLI.",
    categories: ["developer"],
    publisher: "Upstash (Context7)",
    official: true,
    license: "MIT",
    source: {
      repo: "upstash/context7",
      ref: "078c0c731d19eb88d2391b236ab82a127dbabac3",
      path: "skills/find-docs",
    },
    requiresApps: [],
    homepage:
      "https://github.com/upstash/context7/tree/078c0c731d19eb88d2391b236ab82a127dbabac3/skills/find-docs",
  },
  {
    id: "chromedevtools-chrome-devtools-mcp/chrome-devtools",
    name: "chrome-devtools",
    title: "Chrome DevTools",
    description:
      "Debug pages with Chrome DevTools: performance, network, console and browser automation.",
    categories: ["developer"],
    publisher: "Google Chrome DevTools",
    official: true,
    license: "Apache-2.0",
    source: {
      repo: "ChromeDevTools/chrome-devtools-mcp",
      ref: "0b37364dc0a88a804c6d73d3335e776adc7f33c4",
      path: "skills/chrome-devtools",
    },
    requiresApps: ["chrome-devtools"],
    homepage:
      "https://github.com/ChromeDevTools/chrome-devtools-mcp/tree/0b37364dc0a88a804c6d73d3335e776adc7f33c4/skills/chrome-devtools",
  },
  {
    id: "getsentry-sentry-for-ai/sentry-debug-issue",
    name: "sentry-debug-issue",
    title: "Debug Sentry issues",
    description:
      "Find a Sentry issue, pull stack traces and breadcrumbs, fix the code and resolve it.",
    categories: ["developer"],
    publisher: "Sentry",
    official: true,
    license: "MIT",
    source: {
      repo: "getsentry/sentry-for-ai",
      ref: "c198c986a526c7f4f35d11bf79a5f7b036c122ad",
      path: "src/skills/sentry-debug-issue",
    },
    requiresApps: ["sentry"],
    homepage:
      "https://github.com/getsentry/sentry-for-ai/tree/c198c986a526c7f4f35d11bf79a5f7b036c122ad/src/skills/sentry-debug-issue",
  },
  {
    id: "emilkowalski-skills/emil-design-eng",
    name: "emil-design-eng",
    title: "Design engineering (Emil Kowalski)",
    description:
      "Emil Kowalski's approach to UI polish, component design and the details that make software feel great.",
    categories: ["design", "developer"],
    publisher: "Emil Kowalski",
    official: false,
    license: "MIT",
    source: {
      repo: "emilkowalski/skills",
      ref: "5206a950b715e0cabe7043ea0b2304332b91494e",
      path: "skills/emil-design-eng",
    },
    requiresApps: [],
    homepage:
      "https://github.com/emilkowalski/skills/tree/5206a950b715e0cabe7043ea0b2304332b91494e/skills/emil-design-eng",
  },
  {
    id: "emilkowalski-skills/animate",
    name: "animate",
    title: "Animate",
    description:
      "Build UI animations the right way: purpose, properties, easing, duration, interruption and exit.",
    categories: ["design", "developer"],
    publisher: "Emil Kowalski",
    official: false,
    license: "MIT",
    source: {
      repo: "emilkowalski/skills",
      ref: "5206a950b715e0cabe7043ea0b2304332b91494e",
      path: "skills/animate",
    },
    requiresApps: [],
    homepage:
      "https://github.com/emilkowalski/skills/tree/5206a950b715e0cabe7043ea0b2304332b91494e/skills/animate",
  },
  {
    id: "pbakaus-impeccable/impeccable",
    name: "impeccable",
    title: "Impeccable",
    description:
      "Design, critique, audit and polish frontends: hierarchy, layout, type, color, motion and copy.",
    categories: ["design", "developer"],
    publisher: "Paul Bakaus",
    official: false,
    license: "Apache-2.0",
    source: {
      repo: "pbakaus/impeccable",
      ref: "613fbf88e0ef08709eaf238653285f430250c0ea",
      path: ".agents/skills/impeccable",
    },
    requiresApps: [],
    homepage:
      "https://github.com/pbakaus/impeccable/tree/613fbf88e0ef08709eaf238653285f430250c0ea/.agents/skills/impeccable",
  },
  {
    id: "nextlevelbuilder-ui-ux-pro-max-skill/ui-ux-pro-max",
    name: "ui-ux-pro-max",
    title: "UI/UX Pro Max",
    description:
      "Searchable UI/UX knowledge: styles, palettes, font pairings and stack-specific guidance.",
    categories: ["design", "developer"],
    publisher: "Next Level Builder",
    official: false,
    license: "MIT",
    source: {
      repo: "nextlevelbuilder/ui-ux-pro-max-skill",
      ref: "4f2dbb67e64969a9a30ab00742f2d55d66ddec2b",
      path: ".claude/skills/ui-ux-pro-max",
    },
    requiresApps: [],
    homepage:
      "https://github.com/nextlevelbuilder/ui-ux-pro-max-skill/tree/4f2dbb67e64969a9a30ab00742f2d55d66ddec2b/.claude/skills/ui-ux-pro-max",
  },
  {
    id: "shadcn-ui/shadcn",
    name: "shadcn",
    title: "shadcn/ui",
    description:
      "Add, search, style, fix and compose shadcn/ui components and registries in a project.",
    categories: ["developer", "design"],
    publisher: "shadcn",
    official: true,
    license: "MIT",
    source: {
      repo: "shadcn/ui",
      ref: "8ab27715521cbd4f87ae6886cd989cbb678f6de7",
      path: "skills/shadcn",
    },
    requiresApps: [],
    homepage:
      "https://github.com/shadcn/ui/tree/8ab27715521cbd4f87ae6886cd989cbb678f6de7/skills/shadcn",
  },
  {
    id: "figma-mcp-server-guide/figma-use",
    name: "figma-use",
    title: "Figma canvas",
    description:
      "Create and edit Figma files from the agent: frames, components, variables and auto layout.",
    categories: ["design"],
    publisher: "Figma",
    official: true,
    license: "proprietary/Figma Developer Terms",
    source: {
      repo: "figma/mcp-server-guide",
      ref: "19be8d51c6a2f8ca949d33e5cd8e9662c5d243e8",
      path: "skills/figma-use",
    },
    requiresApps: ["figma"],
    homepage:
      "https://github.com/figma/mcp-server-guide/tree/19be8d51c6a2f8ca949d33e5cd8e9662c5d243e8/skills/figma-use",
  },
  {
    id: "figma-mcp-server-guide/figma-design-to-code",
    name: "figma-design-to-code",
    title: "Figma design to code",
    description: "Implement a Figma design as production code with high visual fidelity.",
    categories: ["design", "developer"],
    publisher: "Figma",
    official: true,
    license: "proprietary/Figma Developer Terms",
    source: {
      repo: "figma/mcp-server-guide",
      ref: "19be8d51c6a2f8ca949d33e5cd8e9662c5d243e8",
      path: "skills/figma-design-to-code",
    },
    requiresApps: ["figma"],
    homepage:
      "https://github.com/figma/mcp-server-guide/tree/19be8d51c6a2f8ca949d33e5cd8e9662c5d243e8/skills/figma-design-to-code",
  },
  {
    id: "canva-sdks-canva-skills/canva-resize-for-social-media",
    name: "canva-resize-for-social-media",
    title: "Canva social resize",
    description:
      "Turn one Canva design into channel-ready variants for TikTok, Instagram, LinkedIn, X and more.",
    categories: ["design", "marketing"],
    publisher: "Canva",
    official: true,
    license: "Apache-2.0",
    source: {
      repo: "canva-sdks/canva-skills",
      ref: "972e8cecb4aa1eaf558c2be2f9de5c562d13ff93",
      path: "plugins/canva/skills/resize-for-social-media",
    },
    requiresApps: ["canva"],
    homepage:
      "https://github.com/canva-sdks/canva-skills/tree/972e8cecb4aa1eaf558c2be2f9de5c562d13ff93/plugins/canva/skills/resize-for-social-media",
  },
  {
    id: "remotion-dev-skills/remotion-best-practices",
    name: "remotion-best-practices",
    title: "Remotion videos",
    description:
      "Make videos in React with Remotion: create projects, animate, caption, preview and render.",
    categories: ["creative", "developer"],
    publisher: "Remotion",
    official: true,
    license: "unspecified (vendor-published for installation)",
    source: {
      repo: "remotion-dev/skills",
      ref: "a2824c67f8b4585c294a8101db9f9f0ad3c643f8",
      path: "skills/remotion-best-practices",
    },
    requiresApps: [],
    homepage:
      "https://github.com/remotion-dev/skills/tree/a2824c67f8b4585c294a8101db9f9f0ad3c643f8/skills/remotion-best-practices",
  },
  {
    id: "heygen-com-hyperframes/hyperframes",
    name: "hyperframes",
    title: "HyperFrames video",
    description:
      "Make and render videos from HTML: launch films, explainers, captions, charts and vertical clips.",
    categories: ["creative", "marketing"],
    publisher: "HeyGen",
    official: true,
    license: "Apache-2.0",
    source: {
      repo: "heygen-com/hyperframes",
      ref: "e351253724c7142cc4697de652f353a0fd74b66e",
      path: "skills/hyperframes",
    },
    requiresApps: [],
    homepage:
      "https://github.com/heygen-com/hyperframes/tree/e351253724c7142cc4697de652f353a0fd74b66e/skills/hyperframes",
  },
  {
    id: "elevenlabs-skills/text-to-speech",
    name: "text-to-speech",
    title: "Text to speech (ElevenLabs)",
    description: "Turn text into natural speech and voiceovers in 90+ languages with ElevenLabs.",
    categories: ["creative"],
    publisher: "ElevenLabs",
    official: true,
    license: "MIT",
    source: {
      repo: "elevenlabs/skills",
      ref: "9763c39a9d7add478b2f2d8229f0caadf5414f5f",
      path: "text-to-speech",
    },
    requiresApps: [],
    homepage:
      "https://github.com/elevenlabs/skills/tree/9763c39a9d7add478b2f2d8229f0caadf5414f5f/text-to-speech",
  },
  {
    id: "elevenlabs-skills/music",
    name: "music",
    title: "Music generation (ElevenLabs)",
    description:
      "Generate instrumentals, songs with lyrics, jingles and background music with ElevenLabs.",
    categories: ["creative"],
    publisher: "ElevenLabs",
    official: true,
    license: "MIT",
    source: {
      repo: "elevenlabs/skills",
      ref: "9763c39a9d7add478b2f2d8229f0caadf5414f5f",
      path: "music",
    },
    requiresApps: [],
    homepage:
      "https://github.com/elevenlabs/skills/tree/9763c39a9d7add478b2f2d8229f0caadf5414f5f/music",
  },
  {
    id: "el4cteo-blender-skills/blender-core",
    name: "blender-core",
    title: "Blender",
    description:
      "Drive Blender 5.2+ with Python, live over MCP or headless: modeling, scenes and verification.",
    categories: ["creative"],
    publisher: "EL4CTEO (community)",
    official: false,
    license: "MIT",
    source: {
      repo: "EL4CTEO/blender-skills",
      ref: "389f28addc79b87b28764898e38e7bf408d14b77",
      path: "skills/blender-core",
    },
    requiresApps: [],
    homepage:
      "https://github.com/EL4CTEO/blender-skills/tree/389f28addc79b87b28764898e38e7bf408d14b77/skills/blender-core",
  },
  {
    id: "supabase-agent-skills/supabase",
    name: "supabase",
    title: "Supabase",
    description:
      "Build with Supabase: database, auth, RLS, edge functions, storage, realtime and migrations.",
    categories: ["developer"],
    publisher: "Supabase",
    official: true,
    license: "MIT",
    source: {
      repo: "supabase/agent-skills",
      ref: "c9be0e931b7930f7d02126d04774d904c381e7d7",
      path: "skills/supabase",
    },
    requiresApps: [],
    homepage:
      "https://github.com/supabase/agent-skills/tree/c9be0e931b7930f7d02126d04774d904c381e7d7/skills/supabase",
  },
  {
    id: "neondatabase-agent-skills/neon-postgres",
    name: "neon-postgres",
    title: "Neon Postgres",
    description:
      "Work with Neon Postgres: connections, migrations, branching, autoscaling and restores.",
    categories: ["developer"],
    publisher: "Neon",
    official: true,
    license: "Apache-2.0",
    source: {
      repo: "neondatabase/agent-skills",
      ref: "2b0e2b6f56d2b41c5363049e30e6ab72aa260cce",
      path: "skills/neon-postgres",
    },
    requiresApps: [],
    homepage:
      "https://github.com/neondatabase/agent-skills/tree/2b0e2b6f56d2b41c5363049e30e6ab72aa260cce/skills/neon-postgres",
  },
  {
    id: "cloudflare-skills/cloudflare",
    name: "cloudflare",
    title: "Cloudflare",
    description:
      "Pick and use the right Cloudflare products for apps, agents, storage, networking and security.",
    categories: ["developer"],
    publisher: "Cloudflare",
    official: true,
    license: "Apache-2.0",
    source: {
      repo: "cloudflare/skills",
      ref: "6eb6c781aa9b6438e0c7307bd102788a75fe1a6d",
      path: "skills/cloudflare",
    },
    requiresApps: [],
    homepage:
      "https://github.com/cloudflare/skills/tree/6eb6c781aa9b6438e0c7307bd102788a75fe1a6d/skills/cloudflare",
  },
  {
    id: "stripe-ai/stripe-best-practices",
    name: "stripe-best-practices",
    title: "Stripe best practices",
    description:
      "Integrate Stripe the right way: Checkout, Payment Element, Billing, Connect, Tax and webhooks.",
    categories: ["developer"],
    publisher: "Stripe",
    official: true,
    license: "MIT",
    source: {
      repo: "stripe/ai",
      ref: "43d4af6847eebf4987576e074d7052d750e8750d",
      path: "skills/stripe-best-practices",
    },
    requiresApps: [],
    homepage:
      "https://github.com/stripe/ai/tree/43d4af6847eebf4987576e074d7052d750e8750d/skills/stripe-best-practices",
  },
  {
    id: "shopify-shopify-ai-toolkit/shopify",
    name: "shopify",
    title: "Shopify",
    description:
      "Build on Shopify: Admin and Storefront APIs, Functions, Polaris, Hydrogen, Liquid and the CLI.",
    categories: ["developer"],
    publisher: "Shopify",
    official: true,
    license: "MIT",
    source: {
      repo: "Shopify/shopify-ai-toolkit",
      ref: "a3d20f8dc284a2e8ae25272fa79520888abb5dcb",
      path: "skills/shopify",
    },
    requiresApps: [],
    homepage:
      "https://github.com/Shopify/shopify-ai-toolkit/tree/a3d20f8dc284a2e8ae25272fa79520888abb5dcb/skills/shopify",
  },
  {
    id: "huggingface-skills/hf-cli",
    name: "hf-cli",
    title: "Hugging Face CLI",
    description:
      "Download, upload and manage models, datasets, Spaces and jobs on the Hugging Face Hub.",
    categories: ["developer", "data"],
    publisher: "Hugging Face",
    official: true,
    license: "Apache-2.0",
    source: {
      repo: "huggingface/skills",
      ref: "25910b3d0ba31a2ba102f901cdc9e008c278a69c",
      path: "skills/hf-cli",
    },
    requiresApps: [],
    homepage:
      "https://github.com/huggingface/skills/tree/25910b3d0ba31a2ba102f901cdc9e008c278a69c/skills/hf-cli",
  },
  {
    id: "expo-skills/expo-native-ui",
    name: "expo-native-ui",
    title: "Expo native UI",
    description:
      "Build native-feeling Expo screens with Apple HIG styling, native controls and SF Symbols.",
    categories: ["developer", "design"],
    publisher: "Expo",
    official: true,
    license: "MIT",
    source: {
      repo: "expo/skills",
      ref: "a9e5bd3fa00b4e61f632e43f85da73aee1942582",
      path: "plugins/expo/skills/expo-native-ui",
    },
    requiresApps: [],
    homepage:
      "https://github.com/expo/skills/tree/a9e5bd3fa00b4e61f632e43f85da73aee1942582/plugins/expo/skills/expo-native-ui",
  },
  {
    id: "expo-skills/eas-app-stores",
    name: "eas-app-stores",
    title: "Ship to app stores (EAS)",
    description:
      "Build, sign and submit iOS and Android apps to TestFlight, the App Store and Google Play.",
    categories: ["developer"],
    publisher: "Expo",
    official: true,
    license: "MIT",
    source: {
      repo: "expo/skills",
      ref: "a9e5bd3fa00b4e61f632e43f85da73aee1942582",
      path: "plugins/expo/skills/eas-app-stores",
    },
    requiresApps: [],
    homepage:
      "https://github.com/expo/skills/tree/a9e5bd3fa00b4e61f632e43f85da73aee1942582/plugins/expo/skills/eas-app-stores",
  },
  {
    id: "coreyhaines31-marketingskills/product-marketing",
    name: "product-marketing",
    title: "Product marketing context",
    description:
      "Capture positioning, audience, ICP and brand voice in one context doc the other skills reuse.",
    categories: ["marketing"],
    publisher: "Corey Haines",
    official: false,
    license: "MIT",
    source: {
      repo: "coreyhaines31/marketingskills",
      ref: "96798cf38736ecdba015a1d2b0521b0c8f8f41dd",
      path: "skills/product-marketing",
    },
    requiresApps: [],
    homepage:
      "https://github.com/coreyhaines31/marketingskills/tree/96798cf38736ecdba015a1d2b0521b0c8f8f41dd/skills/product-marketing",
  },
  {
    id: "coreyhaines31-marketingskills/copywriting",
    name: "copywriting",
    title: "Copywriting",
    description:
      "Write and rewrite marketing copy for homepages, landing, pricing and feature pages.",
    categories: ["marketing", "writing"],
    publisher: "Corey Haines",
    official: false,
    license: "MIT",
    source: {
      repo: "coreyhaines31/marketingskills",
      ref: "96798cf38736ecdba015a1d2b0521b0c8f8f41dd",
      path: "skills/copywriting",
    },
    requiresApps: [],
    homepage:
      "https://github.com/coreyhaines31/marketingskills/tree/96798cf38736ecdba015a1d2b0521b0c8f8f41dd/skills/copywriting",
  },
  {
    id: "coreyhaines31-marketingskills/seo-audit",
    name: "seo-audit",
    title: "SEO audit",
    description:
      "Audit a site for technical and on-page SEO issues and explain why it isn't ranking.",
    categories: ["marketing"],
    publisher: "Corey Haines",
    official: false,
    license: "MIT",
    source: {
      repo: "coreyhaines31/marketingskills",
      ref: "96798cf38736ecdba015a1d2b0521b0c8f8f41dd",
      path: "skills/seo-audit",
    },
    requiresApps: [],
    homepage:
      "https://github.com/coreyhaines31/marketingskills/tree/96798cf38736ecdba015a1d2b0521b0c8f8f41dd/skills/seo-audit",
  },
  {
    id: "coreyhaines31-marketingskills/ai-seo",
    name: "ai-seo",
    title: "AI search optimization",
    description:
      "Get cited by ChatGPT, Perplexity and AI Overviews with answer-engine (AEO/GEO) optimization.",
    categories: ["marketing"],
    publisher: "Corey Haines",
    official: false,
    license: "MIT",
    source: {
      repo: "coreyhaines31/marketingskills",
      ref: "96798cf38736ecdba015a1d2b0521b0c8f8f41dd",
      path: "skills/ai-seo",
    },
    requiresApps: [],
    homepage:
      "https://github.com/coreyhaines31/marketingskills/tree/96798cf38736ecdba015a1d2b0521b0c8f8f41dd/skills/ai-seo",
  },
  {
    id: "coreyhaines31-marketingskills/content-strategy",
    name: "content-strategy",
    title: "Content strategy",
    description: "Plan what to publish: topic clusters, content pillars and an editorial calendar.",
    categories: ["marketing", "writing"],
    publisher: "Corey Haines",
    official: false,
    license: "MIT",
    source: {
      repo: "coreyhaines31/marketingskills",
      ref: "96798cf38736ecdba015a1d2b0521b0c8f8f41dd",
      path: "skills/content-strategy",
    },
    requiresApps: [],
    homepage:
      "https://github.com/coreyhaines31/marketingskills/tree/96798cf38736ecdba015a1d2b0521b0c8f8f41dd/skills/content-strategy",
  },
  {
    id: "coreyhaines31-marketingskills/social",
    name: "social",
    title: "Social media",
    description:
      "Create, schedule and repurpose posts for LinkedIn, X, Instagram, TikTok and Facebook.",
    categories: ["marketing", "writing"],
    publisher: "Corey Haines",
    official: false,
    license: "MIT",
    source: {
      repo: "coreyhaines31/marketingskills",
      ref: "96798cf38736ecdba015a1d2b0521b0c8f8f41dd",
      path: "skills/social",
    },
    requiresApps: [],
    homepage:
      "https://github.com/coreyhaines31/marketingskills/tree/96798cf38736ecdba015a1d2b0521b0c8f8f41dd/skills/social",
  },
  {
    id: "coreyhaines31-marketingskills/ads",
    name: "ads",
    title: "Paid ads",
    description:
      "Plan and optimize paid campaigns on Google, Meta, LinkedIn and X: targeting, budget and ROAS.",
    categories: ["marketing"],
    publisher: "Corey Haines",
    official: false,
    license: "MIT",
    source: {
      repo: "coreyhaines31/marketingskills",
      ref: "96798cf38736ecdba015a1d2b0521b0c8f8f41dd",
      path: "skills/ads",
    },
    requiresApps: [],
    homepage:
      "https://github.com/coreyhaines31/marketingskills/tree/96798cf38736ecdba015a1d2b0521b0c8f8f41dd/skills/ads",
  },
  {
    id: "coreyhaines31-marketingskills/ad-creative",
    name: "ad-creative",
    title: "Ad creative",
    description:
      "Generate and iterate ad headlines, descriptions and full variations for any ad platform.",
    categories: ["marketing", "creative"],
    publisher: "Corey Haines",
    official: false,
    license: "MIT",
    source: {
      repo: "coreyhaines31/marketingskills",
      ref: "96798cf38736ecdba015a1d2b0521b0c8f8f41dd",
      path: "skills/ad-creative",
    },
    requiresApps: [],
    homepage:
      "https://github.com/coreyhaines31/marketingskills/tree/96798cf38736ecdba015a1d2b0521b0c8f8f41dd/skills/ad-creative",
  },
  {
    id: "coreyhaines31-marketingskills/launch",
    name: "launch",
    title: "Product launch",
    description:
      "Plan a launch or feature announcement: Product Hunt, GTM plan, checklist and changelog.",
    categories: ["marketing"],
    publisher: "Corey Haines",
    official: false,
    license: "MIT",
    source: {
      repo: "coreyhaines31/marketingskills",
      ref: "96798cf38736ecdba015a1d2b0521b0c8f8f41dd",
      path: "skills/launch",
    },
    requiresApps: [],
    homepage:
      "https://github.com/coreyhaines31/marketingskills/tree/96798cf38736ecdba015a1d2b0521b0c8f8f41dd/skills/launch",
  },
  {
    id: "coreyhaines31-marketingskills/cro",
    name: "cro",
    title: "Conversion optimization",
    description: "Improve conversion on landing pages, pricing pages and forms.",
    categories: ["marketing"],
    publisher: "Corey Haines",
    official: false,
    license: "MIT",
    source: {
      repo: "coreyhaines31/marketingskills",
      ref: "96798cf38736ecdba015a1d2b0521b0c8f8f41dd",
      path: "skills/cro",
    },
    requiresApps: [],
    homepage:
      "https://github.com/coreyhaines31/marketingskills/tree/96798cf38736ecdba015a1d2b0521b0c8f8f41dd/skills/cro",
  },
  {
    id: "coreyhaines31-marketingskills/emails",
    name: "emails",
    title: "Email sequences",
    description: "Design drip, onboarding, nurture and re-engagement email sequences.",
    categories: ["marketing", "writing"],
    publisher: "Corey Haines",
    official: false,
    license: "MIT",
    source: {
      repo: "coreyhaines31/marketingskills",
      ref: "96798cf38736ecdba015a1d2b0521b0c8f8f41dd",
      path: "skills/emails",
    },
    requiresApps: [],
    homepage:
      "https://github.com/coreyhaines31/marketingskills/tree/96798cf38736ecdba015a1d2b0521b0c8f8f41dd/skills/emails",
  },
  {
    id: "coreyhaines31-marketingskills/analytics",
    name: "analytics",
    title: "Analytics tracking",
    description:
      "Set up and audit tracking: GA4, Tag Manager, events, UTM parameters and tracking plans.",
    categories: ["marketing", "data"],
    publisher: "Corey Haines",
    official: false,
    license: "MIT",
    source: {
      repo: "coreyhaines31/marketingskills",
      ref: "96798cf38736ecdba015a1d2b0521b0c8f8f41dd",
      path: "skills/analytics",
    },
    requiresApps: [],
    homepage:
      "https://github.com/coreyhaines31/marketingskills/tree/96798cf38736ecdba015a1d2b0521b0c8f8f41dd/skills/analytics",
  },
  {
    id: "coreyhaines31-marketingskills/ab-testing",
    name: "ab-testing",
    title: "A/B testing",
    description: "Plan, size and analyze A/B tests and build a growth experimentation program.",
    categories: ["marketing", "data"],
    publisher: "Corey Haines",
    official: false,
    license: "MIT",
    source: {
      repo: "coreyhaines31/marketingskills",
      ref: "96798cf38736ecdba015a1d2b0521b0c8f8f41dd",
      path: "skills/ab-testing",
    },
    requiresApps: [],
    homepage:
      "https://github.com/coreyhaines31/marketingskills/tree/96798cf38736ecdba015a1d2b0521b0c8f8f41dd/skills/ab-testing",
  },
  {
    id: "agricidaniel-claude-seo/seo-content-brief",
    name: "seo-content-brief",
    title: "SEO content brief",
    description: "Competitive SEO content briefs with outlines, word counts and keyword placement.",
    categories: ["marketing", "writing"],
    publisher: "AgriciDaniel",
    official: false,
    license: "MIT",
    source: {
      repo: "AgriciDaniel/claude-seo",
      ref: "6be93f45064ffbadced572b5d5c95f55fd263af0",
      path: "skills/seo-content-brief",
    },
    requiresApps: [],
    homepage:
      "https://github.com/AgriciDaniel/claude-seo/tree/6be93f45064ffbadced572b5d5c95f55fd263af0/skills/seo-content-brief",
  },
  {
    id: "addyosmani-web-quality-skills/core-web-vitals",
    name: "core-web-vitals",
    title: "Core Web Vitals",
    description: "Diagnose and fix LCP, INP and CLS using field and lab data.",
    categories: ["developer", "marketing"],
    publisher: "Addy Osmani",
    official: false,
    license: "MIT",
    source: {
      repo: "addyosmani/web-quality-skills",
      ref: "afa8da942115f2961fdbfa80807ea0b232ff6c00",
      path: "skills/core-web-vitals",
    },
    requiresApps: [],
    homepage:
      "https://github.com/addyosmani/web-quality-skills/tree/afa8da942115f2961fdbfa80807ea0b232ff6c00/skills/core-web-vitals",
  },
  {
    id: "resend-resend-skills/email-best-practices",
    name: "email-best-practices",
    title: "Email deliverability",
    description:
      "Keep email out of spam: SPF/DKIM/DMARC, compliance, webhooks, retries and accessibility.",
    categories: ["developer", "marketing"],
    publisher: "Resend",
    official: true,
    license: "MIT",
    source: {
      repo: "resend/resend-skills",
      ref: "389de56a2e48903c4b8ac7b8f2b8ee1f2c1bb9df",
      path: "skills/email-best-practices",
    },
    requiresApps: [],
    homepage:
      "https://github.com/resend/resend-skills/tree/389de56a2e48903c4b8ac7b8f2b8ee1f2c1bb9df/skills/email-best-practices",
  },
  {
    id: "exa-labs-agent-skills/company-research",
    name: "company-research",
    title: "Company research (Exa)",
    description:
      "Research companies, competitors, news and people, and build company lists with Exa.",
    categories: ["marketing", "data"],
    publisher: "Exa",
    official: true,
    license: "MIT",
    source: {
      repo: "exa-labs/agent-skills",
      ref: "a0c2df864db555d470455f932f9c150a97be113b",
      path: "skills/company-research",
    },
    requiresApps: ["exa"],
    homepage:
      "https://github.com/exa-labs/agent-skills/tree/a0c2df864db555d470455f932f9c150a97be113b/skills/company-research",
  },
  {
    id: "firecrawl-cli/firecrawl",
    name: "firecrawl",
    title: "Firecrawl web research",
    description: "Search, scrape, crawl and extract live web pages with the Firecrawl CLI.",
    categories: ["data", "marketing", "developer"],
    publisher: "Firecrawl",
    official: true,
    license: "ISC",
    source: {
      repo: "firecrawl/cli",
      ref: "5533ea907bf8074404360763ddf9102f42724ec1",
      path: "skills/firecrawl",
    },
    requiresApps: [],
    homepage:
      "https://github.com/firecrawl/cli/tree/5533ea907bf8074404360763ddf9102f42724ec1/skills/firecrawl",
  },
  {
    id: "makenotion-claude-code-notion-plugin/notion-knowledge-capture",
    name: "notion-knowledge-capture",
    title: "Notion knowledge capture",
    description:
      "Save conversations and notes to Notion as wiki pages, how-tos, FAQs and decision records.",
    categories: ["productivity", "writing"],
    publisher: "Notion",
    official: true,
    license: "MIT",
    source: {
      repo: "makenotion/claude-code-notion-plugin",
      ref: "016c74ffc568920a385186fb9d2d9d2801e0be09",
      path: "skills/notion/knowledge-capture",
    },
    requiresApps: ["notion"],
    homepage:
      "https://github.com/makenotion/claude-code-notion-plugin/tree/016c74ffc568920a385186fb9d2d9d2801e0be09/skills/notion/knowledge-capture",
  },
  {
    id: "makenotion-claude-code-notion-plugin/notion-spec-to-implementation",
    name: "notion-spec-to-implementation",
    title: "Notion spec to implementation",
    description:
      "Turn a Notion spec into an implementation plan, linked tasks and progress updates.",
    categories: ["productivity", "developer"],
    publisher: "Notion",
    official: true,
    license: "MIT",
    source: {
      repo: "makenotion/claude-code-notion-plugin",
      ref: "016c74ffc568920a385186fb9d2d9d2801e0be09",
      path: "skills/notion/spec-to-implementation",
    },
    requiresApps: ["notion"],
    homepage:
      "https://github.com/makenotion/claude-code-notion-plugin/tree/016c74ffc568920a385186fb9d2d9d2801e0be09/skills/notion/spec-to-implementation",
  },
  {
    id: "makenotion-claude-code-notion-plugin/notion-plan-marketing-campaigns",
    name: "notion-plan-marketing-campaigns",
    title: "Notion campaign planner",
    description: "Organize campaign briefs, content calendars and production tracking in Notion.",
    categories: ["marketing", "productivity"],
    publisher: "Notion",
    official: true,
    license: "MIT",
    source: {
      repo: "makenotion/claude-code-notion-plugin",
      ref: "016c74ffc568920a385186fb9d2d9d2801e0be09",
      path: "skills/notion/plan-marketing-campaigns",
    },
    requiresApps: ["notion"],
    homepage:
      "https://github.com/makenotion/claude-code-notion-plugin/tree/016c74ffc568920a385186fb9d2d9d2801e0be09/skills/notion/plan-marketing-campaigns",
  },
  {
    id: "atlassian-atlassian-mcp-server/spec-to-backlog",
    name: "spec-to-backlog",
    title: "Spec to Jira backlog",
    description: "Turn a Confluence spec into Jira epics and implementation tickets.",
    categories: ["productivity"],
    publisher: "Atlassian",
    official: true,
    license: "Apache-2.0",
    source: {
      repo: "atlassian/atlassian-mcp-server",
      ref: "3be55622453304b905f0c0fd5ef96fa4d638627c",
      path: "skills/spec-to-backlog",
    },
    requiresApps: ["atlassian"],
    homepage:
      "https://github.com/atlassian/atlassian-mcp-server/tree/3be55622453304b905f0c0fd5ef96fa4d638627c/skills/spec-to-backlog",
  },
  {
    id: "atlassian-atlassian-mcp-server/triage-issue",
    name: "triage-issue",
    title: "Jira bug triage",
    description:
      "Triage a bug report: find duplicates in Jira, then file a new ticket or update an existing one.",
    categories: ["productivity", "developer"],
    publisher: "Atlassian",
    official: true,
    license: "Apache-2.0",
    source: {
      repo: "atlassian/atlassian-mcp-server",
      ref: "3be55622453304b905f0c0fd5ef96fa4d638627c",
      path: "skills/triage-issue",
    },
    requiresApps: ["atlassian"],
    homepage:
      "https://github.com/atlassian/atlassian-mcp-server/tree/3be55622453304b905f0c0fd5ef96fa4d638627c/skills/triage-issue",
  },
];
