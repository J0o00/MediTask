// Confidence-aware assessment: decide whether a frame is trustworthy enough
// to score. When it is not, the engine pauses scoring and asks the patient
// to reposition instead of giving potentially misleading corrections.
import { JOINTS } from './skeleton.js';

export const VISIBILITY_MIN = 0.6;

/**
 * @param {{vis:number[], img:number[][]}} frame common-skeleton frame
 * @param {string[]} requiredJoints joint names that must be visible
 * @returns {{ok:boolean, confidence:number, missing:string[], reason:string|null}}
 */
export function validateFrame(frame, requiredJoints) {
    if (!frame) return { ok: false, confidence: 0, missing: requiredJoints, reason: 'no_person' };
    const missing = [];
    let sum = 0;
    for (const name of requiredJoints) {
        const i = JOINTS.indexOf(name);
        const v = frame.vis[i];
        sum += v;
        const [x, y] = frame.img[i] || [NaN, NaN];
        const inFrame = Number.isNaN(x) || (x > 0.01 && x < 0.99 && y > 0.01 && y < 0.99);
        if (v < VISIBILITY_MIN || !inFrame) missing.push(name);
    }
    const confidence = requiredJoints.length ? sum / requiredJoints.length : 1;
    let reason = null;
    if (missing.length) reason = 'joints_not_visible';
    return { ok: missing.length === 0, confidence, missing, reason };
}

const FRIENDLY = {
    L_SHOULDER: 'left shoulder', R_SHOULDER: 'right shoulder', L_ELBOW: 'left elbow', R_ELBOW: 'right elbow',
    L_WRIST: 'left wrist', R_WRIST: 'right wrist', L_HIP: 'left hip', R_HIP: 'right hip',
    L_KNEE: 'left knee', R_KNEE: 'right knee', L_ANKLE: 'left ankle', R_ANKLE: 'right ankle',
};

export function repositionMessage(missing) {
    if (!missing || !missing.length) return '';
    const legs = missing.some(n => /KNEE|ANKLE/.test(n));
    const names = missing.slice(0, 2).map(n => FRIENDLY[n]).join(' and ');
    return legs
        ? `Step back so your whole body is visible (can't see your ${names}).`
        : `Move so your ${names} ${missing.length > 1 ? 'are' : 'is'} clearly visible.`;
}
