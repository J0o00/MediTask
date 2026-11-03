// Canvas overlay: skeleton with per-joint status colours and live angle label.
// Draws directly (no MediaPipe drawing_utils dependency).

const CONNECTIONS = [
    [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24],
    [23, 25], [25, 27], [24, 26], [26, 28], [27, 31], [28, 32], [15, 19], [16, 20],
];
const KEY_POINTS = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];

// Which MediaPipe landmark is the vertex of each metric (for the angle label).
const METRIC_VERTEX = {
    shoulder_r: 12, shoulder_l: 11, shoulder_mean: 12, elbow_r: 14, elbow_l: 13,
    knee_r: 26, knee_l: 25, knee_mean: 26, hip_r: 24, hip_l: 23, hip_abd_r: 24, hip_abd_l: 23,
};
// Joints implicated by each rule id (coloured red when the rule fires).
const RULE_JOINTS = {
    elbow_bent: [14], elbow_bent_l: [13], elbow_bent_r: [14], side_lean: [11, 12], back_lean: [11, 12, 23, 24],
    arm_forward_l: [13, 15], arm_forward_r: [14, 16], asymmetry: [13, 14, 25, 26], overshoot: [13, 14],
    knee_valgus: [25, 26], forward_lean: [11, 12], elbow_drift: [14], body_swing: [11, 12, 23, 24],
    knee_bent: [26], leg_forward: [24, 26],
};

export function drawPose(ctx, canvas, state, cfg) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const lm = state?.landmarks;
    if (!lm) return;
    const W = canvas.width, H = canvas.height;
    const bad = new Set((state.errors || []).flatMap(id => RULE_JOINTS[id] || []));
    const base = !state.valid ? '#f87171' : state.formScore >= 80 ? '#22c55e' : state.formScore >= 50 ? '#eab308' : '#f87171';

    ctx.lineWidth = 4; ctx.lineCap = 'round';
    for (const [a, b] of CONNECTIONS) {
        const p = lm[a], q = lm[b];
        if (!p || !q || (p.visibility ?? 1) < 0.5 || (q.visibility ?? 1) < 0.5) continue;
        ctx.strokeStyle = bad.has(a) && bad.has(b) ? '#ef4444' : 'rgba(255,255,255,0.75)';
        ctx.beginPath(); ctx.moveTo(p.x * W, p.y * H); ctx.lineTo(q.x * W, q.y * H); ctx.stroke();
    }
    for (const i of KEY_POINTS) {
        const p = lm[i];
        if (!p || (p.visibility ?? 1) < 0.5) continue;
        ctx.beginPath(); ctx.arc(p.x * W, p.y * H, 7, 0, Math.PI * 2);
        ctx.fillStyle = bad.has(i) ? '#ef4444' : base; ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = '#0f172a'; ctx.stroke();
    }

    // Live angle at the primary joint. The canvas is mirrored with CSS, so
    // un-mirror the text locally to keep it readable.
    if (state.valid && cfg && state.metrics) {
        const v = METRIC_VERTEX[cfg.primaryMetric];
        const p = v !== undefined ? lm[v] : null;
        const val = state.metrics[cfg.primaryMetric];
        if (p && Number.isFinite(val)) {
            const x = p.x * W, y = p.y * H;
            ctx.save(); ctx.translate(x, y); ctx.scale(-1, 1);
            ctx.font = 'bold 26px Inter, sans-serif';
            const txt = `${Math.round(val)}°`;
            const w = ctx.measureText(txt).width;
            ctx.fillStyle = 'rgba(15,23,42,0.8)'; ctx.fillRect(-w / 2 - 8, -52, w + 16, 34);
            ctx.fillStyle = '#5eead4'; ctx.textAlign = 'center'; ctx.fillText(txt, 0, -26);
            ctx.restore();
        }
    }
}
