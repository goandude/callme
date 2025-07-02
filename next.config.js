
/** @type {import('next').NextConfig} */
const withPWA = require('next-pwa')({
  dest: 'public',
  register: true,
  skipWaiting: true,
  disable: process.env.NODE_ENV === 'development', // Disable PWA in dev mode
});

const nextConfig = {
  reactStrictMode: false, // It's good practice to keep this true for production
};

module.exports = withPWA(nextConfig);