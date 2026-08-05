import type { Config } from 'tailwindcss';

export default {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      boxShadow: {
        soft: '0 10px 30px rgba(15, 23, 42, 0.08)',
        glow: '0 0 0 1px rgba(59, 130, 246, 0.12), 0 20px 60px rgba(59, 130, 246, 0.08)',
      },
      colors: {
        surface: {
          950: '#07111f',
          900: '#0b1728',
          800: '#11203a',
          700: '#1b2d4a',
          100: '#eef3fb',
        },
      },
      backgroundImage: {
        'hero-radial':
          'radial-gradient(circle at top, rgba(59,130,246,0.18), transparent 48%), radial-gradient(circle at right, rgba(16,185,129,0.10), transparent 42%), linear-gradient(180deg, rgba(8,15,29,1) 0%, rgba(7,11,20,1) 100%)',
      },
    },
  },
  plugins: [],
} satisfies Config;
