import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'PNG to SVG Converter',
  description: 'Local-first PNG to SVG converter that runs entirely in the browser.',
  manifest: '/manifest.webmanifest',
  themeColor: '#0b1220',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
