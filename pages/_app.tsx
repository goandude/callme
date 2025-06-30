//
// Filename: /pages/_app.tsx
// Description: This is the root component for your Next.js application.
// Global CSS files can only be imported into this file.
//

import '@/styles/globals.css'
import type { AppProps } from 'next/app'

export default function App({ Component, pageProps }: AppProps) {
  return <Component {...pageProps} />
}
