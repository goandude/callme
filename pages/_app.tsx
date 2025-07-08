// File: pages/_app.tsx
// This is the single, correct version of this file.

import '@/styles/globals.css';
import type { AppProps } from 'next/app';
import { ProfileProvider } from '../context/ProfileContext';

export default function App({ Component, pageProps }: AppProps) {
  return (
    <ProfileProvider>
      <Component {...pageProps} />
    </ProfileProvider>
  );
}