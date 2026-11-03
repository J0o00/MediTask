// Tailwind theme for 404.html (moved out of the page so CSS is compiled ahead of time).
module.exports = {
    content: ['./404.html', './js/**/*.js'],
    plugins: [],
    ...{
            theme: {
                extend: {
                    colors: {
                        primary: '#3152a0',
                        surface: '#faf8ff',
                    },
                    fontFamily: {
                        sans: ['"Plus Jakarta Sans"', 'sans-serif'],
                    }
                }
            }
        },
};
