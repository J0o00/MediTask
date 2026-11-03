// Thin wrappers over Chart.js (loaded globally from the CDN).
const registry = new Map();

// Light clinical theme
const AXIS = { ticks: { color: '#5A6A65', font: { family: 'IBM Plex Sans', size: 12 } }, grid: { color: '#E6ECEA' }, border: { color: '#D9E1DE' } };
export const SERIES = { primary: '#0E5A52', blue: '#2F5F9E', amber: '#B7791F', red: '#B42318', grey: '#8A9A95', teal2: '#5FA89D' };
if (typeof Chart !== 'undefined' && Chart.defaults) { Chart.defaults.font.family = 'IBM Plex Sans'; Chart.defaults.color = '#5A6A65'; }

export function renderChart(canvas, config) {
    if (!canvas || typeof Chart === 'undefined') return null;
    registry.get(canvas)?.destroy();
    const chart = new Chart(canvas.getContext('2d'), config);
    registry.set(canvas, chart);
    return chart;
}

export function barChart(canvas, labels, data, label = '') {
    return renderChart(canvas, {
        type: 'bar',
        data: { labels, datasets: [{ label, data, backgroundColor: SERIES.primary, borderRadius: 4, maxBarThickness: 36 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
            scales: { y: { ...AXIS, beginAtZero: true, ticks: { ...AXIS.ticks, precision: 0 } }, x: { ...AXIS, grid: { display: false } } } },
    });
}

/** series: [{label, data, color, axis?: 'y'|'y2'}] */
export function lineChart(canvas, labels, series, { yTitle = '', y2Title = '', yMax = null, y2Max = null } = {}) {
    const hasY2 = series.some(s => s.axis === 'y2');
    return renderChart(canvas, {
        type: 'line',
        data: {
            labels,
            datasets: series.map(s => ({
                label: s.label, data: s.data, borderColor: s.color, backgroundColor: s.color,
                tension: 0.25, spanGaps: true, pointRadius: 3, borderWidth: 2, yAxisID: s.axis || 'y', borderDash: s.dashed ? [6, 4] : undefined,
            })),
        },
        options: {
            responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
            plugins: { legend: { position: 'bottom', labels: { color: '#3A4A45', boxWidth: 10, boxHeight: 10, usePointStyle: true } } },
            scales: {
                x: { ...AXIS, grid: { display: false } },
                y: { ...AXIS, beginAtZero: true, max: yMax ?? undefined, title: { display: !!yTitle, text: yTitle, color: '#5A6A65' } },
                ...(hasY2 ? { y2: { ...AXIS, position: 'right', beginAtZero: true, max: y2Max ?? undefined, grid: { display: false }, title: { display: !!y2Title, text: y2Title, color: '#5A6A65' } } } : {}),
            },
        },
    });
}
