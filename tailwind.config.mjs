/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        panel: '#16171c',
        surface: '#1e2027',
        edge: '#2b2e38',
      },
    },
  },
  plugins: [],
}
