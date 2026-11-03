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

export function toast(message, kind = 'info', ms = 3500) {
    const colors = { info: 'bg-slate-800 border-teal-500/50', error: 'bg-red-900/90 border-red-500', success: 'bg-emerald-900/90 border-emerald-500' };
    const t = el('div', { class: `fixed top-6 left-1/2 -translate-x-1/2 z-[100] px-5 py-3 rounded-xl border text-white shadow-2xl ${colors[kind] || colors.info}`, role: 'status' }, message);
    document.body.appendChild(t);
    setTimeout(() => t.remove(), ms);
}

export function renderChat(container, messages, myUid) {
    container.replaceChildren();
    if (!messages.length) {
        container.appendChild(el('div', { class: 'text-center text-gray-500 text-sm mt-4' }, 'No messages yet. Start the conversation.'));
        return;
    }
    for (const m of messages) {
        const mine = m.senderId === myUid;
        container.appendChild(el('div', { class: `flex ${mine ? 'justify-end' : 'justify-start'}` },
            el('div', { class: `max-w-[80%] rounded-lg px-3 py-2 ${mine ? 'bg-teal-600 text-white' : 'bg-gray-700 text-gray-200'}` },
                el('p', { class: 'text-[11px] font-semibold opacity-70 mb-0.5' }, mine ? 'You' : (m.senderName || (m.senderRole === 'doctor' ? 'Physiotherapist' : 'Patient'))),
                el('p', { class: 'text-sm whitespace-pre-wrap break-words' }, m.text),
                el('p', { class: 'text-[10px] opacity-50 mt-1 text-right' }, m.createdAt ? fmtDateTime(m.createdAt) : 'sending…'))));
    }
    container.scrollTop = container.scrollHeight;
}

export const PHASE_LABEL = { rest: 'Rest', outward: 'Moving', hold: 'Hold', return: 'Returning' };
export const METRIC_LABEL = {
    shoulder_l: 'Left shoulder', shoulder_r: 'Right shoulder', shoulder_mean: 'Shoulders', elbow_l: 'Left elbow', elbow_r: 'Right elbow',
    knee_l: 'Left knee', knee_r: 'Right knee', knee_mean: 'Knees', hip_l: 'Left hip', hip_r: 'Right hip', hip_abd_r: 'Right hip abduction', hip_abd_l: 'Left hip abduction',
};
