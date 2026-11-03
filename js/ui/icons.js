// Minimal stroke icon set (24x24, 1.75 stroke) used instead of emoji.
// Static markup: <span data-icon="name"></span> is filled by hydrateIcons().
const P = {
    logo: '<path d="M12 21s-7-4.35-7-10a4 4 0 0 1 7-2.65A4 4 0 0 1 19 11c0 5.65-7 10-7 10z"/><path d="M8 12h2l1-2 2 4 1-2h2"/>',
    play: '<path d="M7 5v14l11-7z"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
    send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>',
    userPlus: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0"/><path d="M19 8v6M16 11h6"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
    alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
    volume: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    award: '<circle cx="12" cy="8" r="6"/><path d="M8.2 13.3 7 22l5-3 5 3-1.2-8.7"/>',
    activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    users: '<circle cx="9" cy="7" r="4"/><path d="M2 21a7 7 0 0 1 14 0"/><path d="M16 3.1a4 4 0 0 1 0 7.8M22 21a7 7 0 0 0-5-6.7"/>',
    menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
    arrowLeft: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
    clipboard: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M9 12h6M9 16h4"/>',
    camera: '<path d="M23 7 16 12l7 5z"/><rect x="1" y="5" width="15" height="14" rx="2"/>',
    trend: '<path d="m22 7-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/>',
    // body regions (exercise icons)
    shoulder: '<circle cx="12" cy="4.5" r="2"/><path d="M12 7v7M12 14l-3 7M12 14l3 7M12 9l-6-3M12 9l6-3"/>',
    knee: '<circle cx="12" cy="4" r="2"/><path d="M12 6v6l-4 3 2 6M12 12l4 3-2 6M8 9h8"/>',
    elbow: '<circle cx="9" cy="4" r="2"/><path d="M9 6v9M9 15l-2 6M9 15l2 6M9 8l5 3 2-5"/>',
    hip: '<circle cx="10" cy="4" r="2"/><path d="M10 6v8M10 14l-2 7M10 14l8 4M6 9h8"/>',
};

export function icon(name, cls = '') {
    const tpl = document.createElement('template');
    tpl.innerHTML = `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[name] || P.info}</svg>`;
    return tpl.content.firstChild;
}

export function exerciseIcon(cfg) {
    return icon({ shoulder: 'shoulder', knee: 'knee', elbow: 'elbow', hip: 'hip' }[cfg?.bodyRegion] || 'activity');
}

export function hydrateIcons(root = document) {
    root.querySelectorAll('[data-icon]').forEach(n => { if (!n.firstChild) n.replaceWith(icon(n.dataset.icon, n.className)); });
}
