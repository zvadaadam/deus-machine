import type { ReactNode } from "react";
import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";

import appCss from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Deus Machine — Give your agents a place to live" },
      {
        name: "description",
        content:
          "Close the loop. Plan the work, approve the plan, walk away. Come back to software. Open source IDE for parallel AI coding agents.",
      },
      { property: "og:title", content: "Deus Machine — Give your agents a place to live" },
      {
        property: "og:description",
        content:
          "Close the loop. Plan the work, approve the plan, walk away. Come back to software.",
      },
      { property: "og:type", content: "website" },
      { property: "og:url", content: "https://deusmachine.ai" },
      { property: "og:image", content: "https://deusmachine.ai/logo512.png" },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:title", content: "Deus Machine — Give your agents a place to live" },
      {
        name: "twitter:description",
        content:
          "Close the loop. Plan the work, approve the plan, walk away. Come back to software.",
      },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "icon", type: "image/png", href: "/favicon.png" },
      { rel: "apple-touch-icon", href: "/logo192.png" },
      { rel: "manifest", href: "/manifest.json" },
    ],
  }),
  shellComponent: RootDocument,
  component: RootComponent,
});

function RootComponent() {
  return <Outlet />;
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body className="antialiased">
        {children}
        <Scripts />
      </body>
    </html>
  );
}
