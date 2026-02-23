/** @type {import('tailwindcss').Config} */
const macaronColors = require('./src/colors/macarons');

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/ui/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: macaronColors,
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
      },
      borderRadius: {
        xl: '1.25rem',
        '2xl': '1.75rem',
      },
      boxShadow: {
        macaron: '0 10px 30px rgba(153, 108, 255, 0.2)',
      },
    },
  },
  plugins: [],
};
