// Synthetic MediaPipe-style pose generator for unit tests ONLY.
// Produces 33 world + image landmarks for a standing person facing the camera,
// with controllable joint angles. Never used as training data.

const D2R = Math.PI / 180;

export function standingPose() {
    // MediaPipe world coords: metres, hip-centred, x right (image), y down, z negative toward camera.
    const P = Array.from({ length: 33 }, () => ({ x: 0, y: -0.6, z: 0, visibility: 0.99 }));
    const set = (i, x, y, z = 0) => { P[i] = { x, y, z, visibility: 0.99 }; };
    set(11, 0.18, -0.5); set(12, -0.18, -0.5);          // shoulders (11 = subject's left, image right)
    set(13, 0.20, -0.22); set(14, -0.20, -0.22);        // elbows (arms down)
    set(15, 0.21, 0.03); set(16, -0.21, 0.03);          // wrists
    set(23, 0.10, 0); set(24, -0.10, 0);                // hips
    set(25, 0.11, 0.45); set(26, -0.11, 0.45);          // knees
    set(27, 0.12, 0.88); set(28, -0.12, 0.88);          // ankles
    return P;
}

/** Elevate one arm by `deg` in a plane: plane 0 = sideways (abduction), 90 = forward (flexion). */
export function setArm(P, side, deg, { plane = 0, elbowFlex = 0 } = {}) {
    const s = side === 'L' ? 11 : 12, e = side === 'L' ? 13 : 14, w = side === 'L' ? 15 : 16;
    const out = side === 'L' ? 1 : -1;
    const th = deg * D2R, pl = plane * D2R;
    const dir = [out * Math.sin(th) * Math.cos(pl), Math.cos(th), -Math.sin(th) * Math.sin(pl)];
    const S = P[s];
    P[e] = { x: S.x + 0.28 * dir[0], y: S.y + 0.28 * dir[1], z: S.z + 0.28 * dir[2], visibility: 0.99 };
    // forearm: bend toward body front by elbowFlex
    const f = elbowFlex * D2R;
    const fdir = [dir[0] * Math.cos(f), dir[1] * Math.cos(f), dir[2] * Math.cos(f) - Math.sin(f)];
    const n = Math.hypot(...fdir) || 1;
    const E = P[e];
    P[w] = { x: E.x + 0.25 * fdir[0] / n, y: E.y + 0.25 * fdir[1] / n, z: E.z + 0.25 * fdir[2] / n, visibility: 0.99 };
    return P;
}

/** Squat with knee angle `kneeDeg` (180 = straight). Knees travel toward the camera. */
export function setSquat(P, kneeDeg, { valgus = 0 } = {}) {
    const bend = (180 - kneeDeg) / 2 * D2R;
    const thigh = 0.45, shank = 0.43;
    for (const [h, k, a, sx] of [[23, 25, 27, 1], [24, 26, 28, -1]]) {
        const ankle = { x: sx * 0.12, y: 0.88, z: 0 };
        const knee = { x: sx * (0.11 - valgus), y: ankle.y - shank * Math.cos(bend), z: -shank * Math.sin(bend) };
        const hip = { x: sx * 0.10, y: knee.y - thigh * Math.cos(bend), z: 0 };
        P[a] = { ...ankle, visibility: 0.99 }; P[k] = { ...knee, visibility: 0.99 }; P[h] = { ...hip, visibility: 0.99 };
    }
    const hy = P[23].y;
    for (const [i, x] of [[11, 0.18], [12, -0.18]]) P[i] = { x, y: hy - 0.5, z: 0, visibility: 0.99 };
    for (const [i, x, dy] of [[13, 0.2, 0.28], [14, -0.2, 0.28], [15, 0.21, 0.53], [16, -0.21, 0.53]]) P[i] = { x, y: hy - 0.5 + dy, z: 0, visibility: 0.99 };
    return P;
}

/** Wrap world landmarks into a MediaPipe-like results object (with image landmarks). */
export function toResults(P) {
    const image = P.map(p => ({ x: 0.5 + p.x * 0.5, y: 0.45 + p.y * 0.45, z: p.z, visibility: p.visibility }));
    return { poseWorldLandmarks: P.map(p => ({ ...p })), poseLandmarks: image };
}

/** A smooth movement profile 0..1..0 over n frames with a hold. */
export function profile(n, hold = 0.2) {
    const rise = (1 - hold) / 2;
    return Array.from({ length: n }, (_, i) => {
        const x = i / (n - 1);
        if (x < rise) return 0.5 - 0.5 * Math.cos(Math.PI * x / rise);
        if (x < rise + hold) return 1;
        return 0.5 + 0.5 * Math.cos(Math.PI * (x - rise - hold) / rise);
    });
}
