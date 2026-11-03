// Small DOM helpers. All user-generated text goes through textContent or
// escapeHtml - never raw innerHTML - to prevent script injection via chat
// messages, names or notes.

export function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** el('div', {class: 'x', onclick: fn}, 'text', childNode, ...) */
export function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
        if (c === null || c === undefined || c === false) continue;
        node.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
}

export const $ = (id) => document.getElementById(id);
export function show(node, on = true) { (typeof node === 'string' ? $(node) : node)?.classList.toggle('hidden', !on); }

export function toDate(ts) { return ts?.toDate ? ts.toDate() : (ts instanceof Date ? ts : (ts ? new Date(ts) : null)); }
export function fmtDate(ts, opts = { dateStyle: 'medium' }) { const d = toDate(ts); return d ? d.toLocaleDateString(undefined, opts) : '—'; }
export function fmtDateTime(ts) { const d = toDate(ts); return d ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—'; }

let toastTimer = null;
export function toast(message, kind = 'info', ms = 3500) {
    document.querySelector('.toast')?.remove();
    const t = el('div', { class: `toast ${kind === 'info' ? '' : kind}`, role: 'status' }, message);
    document.body.appendChild(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), ms);
}

export function initials(name) {
    const parts = String(name || '?').replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
    return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
}

export function renderChat(container, messages, myUid) {
    container.replaceChildren();
    if (!messages.length) {
        container.appendChild(el('div', { class: 'empty small' }, el('h3', {}, 'No messages yet'), 'Ask a question or tell your care team how your exercises are going.'));
        return;
    }
    for (const m of messages) {
        const mine = m.senderId === myUid;
        container.appendChild(el('div', { class: `msg ${mine ? 'mine' : ''}` },
            el('p', { class: 'msg-who' }, mine ? 'You' : (m.senderName || (m.senderRole === 'doctor' ? 'Physiotherapist' : 'Patient'))),
            el('p', { class: 'msg-text' }, m.text),
            el('p', { class: 'msg-time' }, m.createdAt ? fmtDateTime(m.createdAt) : 'Sending…')));
    }
    container.scrollTop = container.scrollHeight;
}

export const PHASE_LABEL = { rest: 'Rest', outward: 'Moving', hold: 'Hold', return: 'Return' };
export const METRIC_LABEL = {
    shoulder_l: 'Left shoulder', shoulder_r: 'Right shoulder', shoulder_mean: 'Shoulders', elbow_l: 'Left elbow', elbow_r: 'Right elbow',
    knee_l: 'Left knee', knee_r: 'Right knee', knee_mean: 'Knees', hip_l: 'Left hip', hip_r: 'Right hip', hip_abd_r: 'Right hip abduction', hip_abd_l: 'Left hip abduction',
};
