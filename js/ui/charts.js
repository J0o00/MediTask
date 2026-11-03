// Thin wrappers over Chart.js (loaded globally from the CDN).
const registry = new Map();

const AXIS = { ticks: { color: '#9ca3af' }, grid: { color: 'rgba(75, 85, 99, 0.3)' } };

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
        data: { labels, datasets: [{ label, data, backgroundColor: 'rgba(20, 184, 166, 0.7)', borderRadius: 6 }] },
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
                tension: 0.3, spanGaps: true, pointRadius: 3, yAxisID: s.axis || 'y', borderDash: s.dashed ? [6, 4] : undefined,
            })),
        },
        options: {
            responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
            plugins: { legend: { labels: { color: '#cbd5e1', boxWidth: 12 } } },
            scales: {
                x: { ...AXIS, grid: { display: false } },
                y: { ...AXIS, beginAtZero: true, max: yMax ?? undefined, title: { display: !!yTitle, text: yTitle, color: '#9ca3af' } },
                ...(hasY2 ? { y2: { ...AXIS, position: 'right', beginAtZero: true, max: y2Max ?? undefined, grid: { display: false }, title: { display: !!y2Title, text: y2Title, color: '#9ca3af' } } } : {}),
            },
        },
    });
}
