// Tailwind theme for doctor-dashboard.html (moved out of the page so CSS is compiled ahead of time).
module.exports = {
    content: ['./doctor-dashboard.html', './js/**/*.js'],
    plugins: [require('@tailwindcss/forms'), require('@tailwindcss/container-queries')],
    ...{
            theme: {
                extend: {
                    colors: {
                        surface: '#FAF8F4',
                        'surface-dim': '#F3ECE2',
                        charcoal: '#1D1C16',
                        slate: '#444845',
                        'slate-light': '#665D51',
                        'border-warm': '#E5DFD5',
                        'border-subtle': '#EDE7DD',
                    },
                    fontFamily: {
                        sans: ['Manrope', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
                        serif: ['Newsreader', 'Georgia', 'serif'],
                    }
                }
            }
        },
};
