// Tailwind theme for patient-dashboard.html (moved out of the page so CSS is compiled ahead of time).
module.exports = {
    content: ['./patient-dashboard.html', './js/**/*.js'],
    plugins: [require('@tailwindcss/forms'), require('@tailwindcss/container-queries')],
    ...{
            theme: {
                extend: {
                    fontFamily: {
                        sans: ['"Plus Jakarta Sans"', 'sans-serif'],
                    },
                    colors: {
                        brand: {
                            50: '#f0f5ff',
                            100: '#e5edff',
                            400: '#818cf8',
                            500: '#6366f1',
                            600: '#4f46e5',
                        },
                        lumis: {
                            blue: '#4a6fa5',
                            lavender: '#9da7c9',
                            peach: '#f4c4b8',
                            surface: 'rgba(255, 255, 255, 0.45)',
                            glass: 'rgba(255, 255, 255, 0.65)',
                            border: 'rgba(255, 255, 255, 0.75)',
                        }
                    },
                    boxShadow: {
                        'glass': '0 8px 32px 0 rgba(74, 111, 165, 0.12), inset 0 1px 1px 0 rgba(255, 255, 255, 0.9)',
                        'glass-active': '0 12px 36px 0 rgba(79, 70, 229, 0.18), inset 0 1px 1px 0 rgba(255, 255, 255, 0.9)',
                        'dock': '0 16px 40px rgba(50, 65, 110, 0.18), inset 0 1px 2px rgba(255, 255, 255, 0.8)',
                    }
                }
            }
        },
};
