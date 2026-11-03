// Tailwind theme for index.html (moved out of the page so CSS is compiled ahead of time).
module.exports = {
    content: ['./index.html', './js/**/*.js'],
    plugins: [],
    ...{
            darkMode: "class",
            theme: {
                extend: {
                    colors: {
                        "surface": "#faf8ff",
                        "surface-dim": "#d1d9f6",
                        "surface-bright": "#faf8ff",
                        "surface-container-lowest": "#ffffff",
                        "surface-container-low": "#f2f3ff",
                        "surface-container": "#eaedff",
                        "surface-container-high": "#e1e7ff",
                        "surface-container-highest": "#d9e2ff",
                        "on-surface": "#121b30",
                        "on-surface-variant": "#444651",
                        "outline": "#747782",
                        "outline-variant": "#c4c6d3",
                        "primary": "#3152a0",
                        "on-primary": "#ffffff",
                        "primary-container": "#4c6bba",
                        "on-primary-container": "#f0f1ff",
                        "primary-fixed": "#dae2ff",
                        "primary-fixed-dim": "#b2c5ff",
                        "secondary": "#94455b",
                        "on-secondary": "#ffffff",
                        "secondary-container": "#fe9cb5",
                        "on-secondary-container": "#7a3046",
                        "secondary-fixed": "#ffd9e0",
                        "tertiary": "#00623e",
                        "on-tertiary": "#ffffff",
                        "tertiary-container": "#007e50",
                        "tertiary-fixed": "#62fdb2",
                        "tertiary-fixed-dim": "#3ee098",
                        "on-tertiary-fixed": "#002111"
                    },
                    fontFamily: {
                        sans: ['"Plus Jakarta Sans"', 'sans-serif']
                    }
                }
            }
        },
};
