// Biomechanical metrics computed on a normalised common-skeleton frame.
// All angles are in degrees. Keep in sync with ml/meditask_ml/metrics.py.
import { J } from './skeleton.js';

const RAD = 180 / Math.PI;

export function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
export function norm(v) { return Math.hypot(v[0], v[1], v[2]); }

/** Angle at vertex b formed by a-b-c, in degrees [0,180]. */
export function angle3(a, b, c) {
    const u = sub(a, b), v = sub(c, b);
    const nu = norm(u), nv = norm(v);
    if (nu < 1e-9 || nv < 1e-9) return 0;
    let cos = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (nu * nv);
    cos = Math.max(-1, Math.min(1, cos));
    return Math.acos(cos) * RAD;
}

/** Classic 2-D image-plane angle (kept for the legacy overlay). */
export function angle2(a, b, c) {
    const r = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(a.y - b.y, a.x - b.x);
    let deg = Math.abs(r * RAD);
    return deg > 180 ? 360 - deg : deg;
}

// The 10 angles that enter the ML feature vector, in this order.
export const FEATURE_ANGLES = [
    'elbow_l', 'elbow_r', 'shoulder_l', 'shoulder_r', 'hip_l', 'hip_r',
    'knee_l', 'knee_r', 'trunk_incl', 'shoulder_tilt',
];

/**
 * Compute every named metric used by exercise configs and the ML features.
 * @param {number[][]} q normalised 12x3 frame
 */
export function computeMetrics(q) {
    const LS = q[J.L_SHOULDER], RS = q[J.R_SHOULDER], LE = q[J.L_ELBOW], RE = q[J.R_ELBOW];
    const LW = q[J.L_WRIST], RW = q[J.R_WRIST], LH = q[J.L_HIP], RH = q[J.R_HIP];
    const LK = q[J.L_KNEE], RK = q[J.R_KNEE], LA = q[J.L_ANKLE], RA = q[J.R_ANKLE];

    const midS = [(LS[0] + RS[0]) / 2, (LS[1] + RS[1]) / 2, (LS[2] + RS[2]) / 2];
    const midH = [(LH[0] + RH[0]) / 2, (LH[1] + RH[1]) / 2, (LH[2] + RH[2]) / 2];
    const trunk = sub(midS, midH);
    const nt = norm(trunk);
    const trunk_incl = nt < 1e-9 ? 0 : Math.acos(Math.max(-1, Math.min(1, trunk[1] / nt))) * RAD;

    const sv = sub(LS, RS);
    const shoulder_tilt = Math.atan2(Math.abs(sv[1]), Math.hypot(sv[0], sv[2])) * RAD;

    const m = {
        elbow_l: angle3(LS, LE, LW),
        elbow_r: angle3(RS, RE, RW),
        shoulder_l: angle3(LH, LS, LE),   // arm elevation, plane-independent
        shoulder_r: angle3(RH, RS, RE),
        hip_l: angle3(LS, LH, LK),
        hip_r: angle3(RS, RH, RK),
        knee_l: angle3(LH, LK, LA),
        knee_r: angle3(RH, RK, RA),
        trunk_incl,
        shoulder_tilt,
    };

    // ---- derived metrics used only by the rule layer ----
    m.shoulder_mean = (m.shoulder_l + m.shoulder_r) / 2;
    m.knee_mean = (m.knee_l + m.knee_r) / 2;
    m.hip_mean = (m.hip_l + m.hip_r) / 2;
    m.elbow_mean = (m.elbow_l + m.elbow_r) / 2;
    // Plane of arm elevation: 0 = pure abduction (sideways), 90 = flexion (forward).
    m.arm_plane_l = armPlane(sub(LE, LS), +1);
    m.arm_plane_r = armPlane(sub(RE, RS), -1);
    // Frontal-plane hip abduction (leg moving out to the side), signed.
    m.hip_abd_l = frontalAbduction(sub(LK, LH), +1);
    m.hip_abd_r = frontalAbduction(sub(RK, RH), -1);
    // Sagittal-plane hip flexion (thigh moving forward), signed; independent of abduction.
    m.hip_flex_l = sagittalFlexion(sub(LK, LH));
    m.hip_flex_r = sagittalFlexion(sub(RK, RH));
    // Knee width relative to ankle width (< ~0.75 suggests knees collapsing inwards).
    const ankleW = Math.abs(LA[0] - RA[0]);
    m.knee_width_ratio = Math.abs(LK[0] - RK[0]) / Math.max(ankleW, 1e-6);
    // Wrist height above the shoulder in torso lengths (positive = above).
    m.wrist_height_l = LW[1] - LS[1];
    m.wrist_height_r = RW[1] - RS[1];
    return m;
}

function armPlane(v, side) {
    const h = Math.hypot(v[0], v[2]);
    if (h < 0.15 * norm(v) || h < 1e-6) return -1;   // arm near vertical: plane undefined
    return Math.atan2(Math.abs(v[2]), side * v[0]) * RAD;
}

function sagittalFlexion(v) {
    if (Math.hypot(v[1], v[2]) < 1e-9) return 0;
    return Math.atan2(v[2], -v[1]) * RAD;
}

function frontalAbduction(v, side) {
    if (Math.hypot(v[0], v[1]) < 1e-9) return 0;
    return Math.atan2(side * v[0], -v[1]) * RAD;
}
