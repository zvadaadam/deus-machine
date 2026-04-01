import { HeadContent, Outlet, Scripts, createRootRoute } from '@tanstack/react-router'

import appCss from '../styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Deus Machine — AI-Powered IDE' },
      { name: 'description', content: 'Manage multiple parallel AI coding agents at once. Ship faster with Deus Machine.' },
      { property: 'og:title', content: 'Deus Machine — AI-Powered IDE' },
      { property: 'og:description', content: 'Manage multiple parallel AI coding agents at once. Ship faster with Deus Machine.' },
      { property: 'og:type', content: 'website' },
      { property: 'og:url', content: 'https://deusmachine.ai' },
      { property: 'og:image', content: 'https://deusmachine.ai/logo512.png' },
      { name: 'twitter:card', content: 'summary' },
      { name: 'twitter:title', content: 'Deus Machine — AI-Powered IDE' },
      { name: 'twitter:description', content: 'Manage multiple parallel AI coding agents at once. Ship faster with Deus Machine.' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
      { rel: 'icon', type: 'image/png', href: '/favicon.png' },
      { rel: 'apple-touch-icon', href: '/logo192.png' },
      { rel: 'manifest', href: '/manifest.json' },
    ],
  }),
  shellComponent: RootDocument,
  component: RootComponent,
})

function RootComponent() {
  return <Outlet />
}

function RootDocument({ children }: { children: React.ReactNode }) {
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
  )
}
