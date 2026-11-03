// Common 12-joint skeleton shared by the browser app and the Python ML pipeline.
// Every source (MediaPipe, Kinect-based KIMORE / UI-PRMD, REHAB24-6) is mapped
// to this joint set so that one model can be trained on all of them.
// Keep in sync with ml/meditask_ml/skeleton.py (checked by tests/parity).

export const JOINTS = [
    'L_SHOULDER', 'R_SHOULDER', 'L_ELBOW', 'R_ELBOW', 'L_WRIST', 'R_WRIST',
    'L_HIP', 'R_HIP', 'L_KNEE', 'R_KNEE', 'L_ANKLE', 'R_ANKLE',
];
export const J = Object.fromEntries(JOINTS.map((n, i) => [n, i]));
export const NUM_JOINTS = JOINTS.length;

// MediaPipe Pose (33 landmarks) indices for each common joint.
export const MEDIAPIPE_INDEX = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];

/**
 * Convert MediaPipe results to the common skeleton.
 * Uses world landmarks (metres, hip-centred) when available because joint
 * angles in 3-D are far less sensitive to camera position than image angles.
 * MediaPipe world axes: x right, y down, z towards the camera is negative.
 * We flip y and z so the frame is right-handed with y pointing up.
 * @returns {{pts:number[][], vis:number[], img:number[][]}}
 */
export function fromMediaPipe(worldLandmarks, imageLandmarks) {
    const src = worldLandmarks && worldLandmarks.length >= 33 ? worldLandmarks : imageLandmarks;
    const useWorld = src === worldLandmarks;
    const pts = [], vis = [], img = [];
    for (const idx of MEDIAPIPE_INDEX) {
        const p = src[idx];
        const v = (imageLandmarks?.[idx]?.visibility ?? p.visibility ?? 1);
        if (useWorld) pts.push([p.x, -p.y, -p.z]);
        else pts.push([p.x, -p.y, -(p.z || 0)]);
        vis.push(clamp01(v));
        const ip = imageLandmarks?.[idx];
        img.push(ip ? [ip.x, ip.y] : [NaN, NaN]);
    }
    return { pts, vis, img };
}

/**
 * Normalise a frame: centre on mid-hip, scale by torso length, and rotate
 * about the vertical axis so the right-hip -> left-hip vector points along +x.
 * This removes the subject's position, size and orientation relative to the camera.
 * @param {number[][]} pts 12x3, right-handed, y up
 * @returns {number[][]} 12x3 normalised
 */
export function normalizeFrame(pts) {
    const lh = pts[J.L_HIP], rh = pts[J.R_HIP], ls = pts[J.L_SHOULDER], rs = pts[J.R_SHOULDER];
    const mh = [(lh[0] + rh[0]) / 2, (lh[1] + rh[1]) / 2, (lh[2] + rh[2]) / 2];
    const ms = [(ls[0] + rs[0]) / 2, (ls[1] + rs[1]) / 2, (ls[2] + rs[2]) / 2];
    let scale = Math.hypot(ms[0] - mh[0], ms[1] - mh[1], ms[2] - mh[2]);
    if (!(scale > 1e-6)) scale = 1;

    const q = pts.map(p => [(p[0] - mh[0]) / scale, (p[1] - mh[1]) / scale, (p[2] - mh[2]) / scale]);

    const hx = q[J.L_HIP][0] - q[J.R_HIP][0];
    const hz = q[J.L_HIP][2] - q[J.R_HIP][2];
    if (Math.hypot(hx, hz) > 1e-6) {
        const th = Math.atan2(hz, hx);
        const c = Math.cos(th), s = Math.sin(th);
        for (const p of q) {
            const x = p[0], z = p[2];
            p[0] = x * c + z * s;
            p[2] = -x * s + z * c;
        }
    }
    return q;
}

export function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
