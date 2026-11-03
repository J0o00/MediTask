// Configuration-driven exercise definitions.
// Adding an exercise = adding an entry here; no analysis code changes needed.
// IMPORTANT: thresholds are initial ENGINEERING parameters for a prototype,
// not clinically validated prescriptions. They must be reviewed by a
// physiotherapist before use with patients.
// This file is exported to ml/config/exercises.json by `npm run export-configs`
// so the Python rule-based baseline uses identical thresholds.

const ARM_R = ['R_SHOULDER', 'R_ELBOW', 'R_WRIST', 'R_HIP', 'L_SHOULDER', 'L_HIP'];
const BOTH_ARMS = ['L_SHOULDER', 'R_SHOULDER', 'L_ELBOW', 'R_ELBOW', 'L_WRIST', 'R_WRIST', 'L_HIP', 'R_HIP'];
const LOWER = ['L_SHOULDER', 'R_SHOULDER', 'L_HIP', 'R_HIP', 'L_KNEE', 'R_KNEE', 'L_ANKLE', 'R_ANKLE'];

/** Shared state-machine fractions of the rest->target range. */
// Note: rep duration is measured between the 20 % entry and exit thresholds, so it is
// shorter than the full movement - minRepMs values below account for that.
export const REP_THRESHOLDS = {
    enter: 0.20,      // left rest: movement started
    target: 1.00,     // reached prescribed range
    holdExit: 0.85,   // started returning from target
    rest: 0.20,       // back at rest: repetition finished
    partial: 0.50,    // returned without target but beyond this -> incomplete rep
    abortMs: 1500,    // tracking lost for longer than this mid-rep -> rep discarded
};

export const EXERCISES = {
    right_hand_raise: {
        id: 'right_hand_raise',
        name: 'Right Hand Raise',
        emoji: '🙋',
        bodyRegion: 'shoulder',
        primaryMetric: 'shoulder_r',
        direction: 'increase',
        restValue: 20,
        targetValue: 150,
        holdMs: 300,
        minRepMs: 1000,
        maxRepMs: 8000,
        requiredJoints: ARM_R,
        romJoints: ['shoulder_r', 'elbow_r'],
        bilateralPairs: [],
        rules: [
            { id: 'elbow_bent', metric: 'elbow_r', op: '<', value: 145, phases: ['outward', 'hold'], severity: 2,
              message: 'Keep your right arm straight' },
            { id: 'side_lean', metric: 'shoulder_tilt', op: '>', value: 12, phases: ['outward', 'hold', 'return'], severity: 2,
              message: 'Avoid leaning to the side - keep shoulders level' },
            { id: 'back_lean', metric: 'trunk_incl', op: '>', value: 15, phases: ['outward', 'hold'], severity: 1,
              message: "Stand tall - don't arch or lean back" },
        ],
        steps: [
            'Stand straight with arms relaxed at your sides',
            'Keep your right arm straight',
            'Raise your right arm forward and up above your head',
            'Hold briefly, then lower slowly',
        ],
        cues: { outward: 'Raise your arm higher', hold: 'Hold it there', return: 'Lower slowly', rest: 'Raise your right arm' },
    },

    shoulder_abduction: {
        id: 'shoulder_abduction',
        name: 'Shoulder Abduction',
        emoji: '🧍',
        bodyRegion: 'shoulder',
        primaryMetric: 'shoulder_mean',
        direction: 'increase',
        restValue: 20,
        targetValue: 85,
        holdMs: 500,
        minRepMs: 1200,
        maxRepMs: 9000,
        requiredJoints: BOTH_ARMS,
        romJoints: ['shoulder_l', 'shoulder_r'],
        bilateralPairs: [['shoulder_l', 'shoulder_r']],
        rules: [
            { id: 'arm_forward_l', metric: 'arm_plane_l', op: '>', value: 40, phases: ['outward', 'hold'], severity: 2,
              message: 'Raise your left arm out to the side, not forward' },
            { id: 'arm_forward_r', metric: 'arm_plane_r', op: '>', value: 40, phases: ['outward', 'hold'], severity: 2,
              message: 'Raise your right arm out to the side, not forward' },
            { id: 'asymmetry', metric: 'shoulder_l', op: 'absdiff>', metricB: 'shoulder_r', value: 15, phases: ['outward', 'hold'], severity: 2,
              message: 'Raise both arms to the same height' },
            { id: 'elbow_bent_l', metric: 'elbow_l', op: '<', value: 150, phases: ['hold'], severity: 1,
              message: 'Straighten your left elbow' },
            { id: 'elbow_bent_r', metric: 'elbow_r', op: '<', value: 150, phases: ['hold'], severity: 1,
              message: 'Straighten your right elbow' },
            { id: 'overshoot', metric: 'shoulder_mean', op: '>', value: 120, phases: ['hold'], severity: 1,
              message: 'Stop at shoulder height' },
            { id: 'side_lean', metric: 'shoulder_tilt', op: '>', value: 10, phases: ['outward', 'hold'], severity: 2,
              message: 'Keep your shoulders level' },
        ],
        steps: [
            'Stand with arms relaxed at your sides, palms facing in',
            'Raise both arms out to the sides',
            'Stop when your arms are at shoulder height (T-pose)',
            'Hold, then lower slowly',
        ],
        cues: { outward: 'Keep raising to shoulder height', hold: 'Hold the T-pose', return: 'Lower slowly', rest: 'Raise both arms to the side' },
    },

    squat: {
        id: 'squat',
        name: 'Squat',
        emoji: '🏋️',
        bodyRegion: 'knee',
        primaryMetric: 'knee_mean',
        direction: 'decrease',
        restValue: 170,
        targetValue: 100,
        holdMs: 0,
        minRepMs: 1200,
        maxRepMs: 10000,
        requiredJoints: LOWER,
        romJoints: ['knee_l', 'knee_r', 'hip_l', 'hip_r'],
        bilateralPairs: [['knee_l', 'knee_r'], ['hip_l', 'hip_r']],
        rules: [
            { id: 'knee_valgus', metric: 'knee_width_ratio', op: '<', value: 0.75, phases: ['outward', 'hold'], severity: 3,
              message: 'Push your knees outward - in line with your toes' },
            { id: 'forward_lean', metric: 'trunk_incl', op: '>', value: 45, phases: ['outward', 'hold'], severity: 2,
              message: 'Keep your chest up - avoid leaning too far forward' },
            { id: 'asymmetry', metric: 'knee_l', op: 'absdiff>', metricB: 'knee_r', value: 15, phases: ['outward', 'hold'], severity: 2,
              message: 'Shift your weight evenly onto both legs' },
        ],
        steps: [
            'Stand with feet shoulder-width apart, facing the camera',
            'Bend your knees and push your hips back',
            'Lower until your thighs approach parallel (or as far as prescribed)',
            'Push through your heels to stand up',
        ],
        cues: { outward: 'Go a little lower', hold: 'Good depth - now rise', return: 'Push up through your heels', rest: 'Bend your knees to begin' },
    },

    elbow_flexion: {
        id: 'elbow_flexion',
        name: 'Elbow Flexion (Right)',
        emoji: '💪',
        bodyRegion: 'elbow',
        primaryMetric: 'elbow_r',
        direction: 'decrease',
        restValue: 160,
        targetValue: 60,
        holdMs: 200,
        minRepMs: 800,
        maxRepMs: 8000,
        requiredJoints: ARM_R,
        romJoints: ['elbow_r'],
        bilateralPairs: [],
        rules: [
            { id: 'elbow_drift', metric: 'shoulder_r', op: '>', value: 35, phases: ['outward', 'hold', 'return'], severity: 2,
              message: 'Keep your upper arm still, close to your side' },
            { id: 'body_swing', metric: 'trunk_incl', op: '>', value: 12, phases: ['outward', 'hold'], severity: 2,
              message: "Don't swing your body - move only the forearm" },
        ],
        steps: [
            'Stand or sit tall with your right arm by your side',
            'Keep your upper arm still',
            'Bend your elbow to bring your hand towards your shoulder',
            'Lower slowly until the arm is straight again',
        ],
        cues: { outward: 'Bend a little further', hold: 'Hold', return: 'Lower slowly', rest: 'Bend your right elbow' },
    },

    lateral_leg_raise: {
        id: 'lateral_leg_raise',
        name: 'Lateral Leg Raise (Right)',
        emoji: '🦵',
        bodyRegion: 'hip',
        primaryMetric: 'hip_abd_r',
        direction: 'increase',
        restValue: 3,
        targetValue: 25,
        holdMs: 300,
        minRepMs: 1000,
        maxRepMs: 8000,
        requiredJoints: LOWER,
        romJoints: ['hip_abd_r'],
        bilateralPairs: [],
        rules: [
            { id: 'side_lean', metric: 'shoulder_tilt', op: '>', value: 12, phases: ['outward', 'hold'], severity: 2,
              message: 'Keep your torso upright - hold a chair if needed' },
            { id: 'knee_bent', metric: 'knee_r', op: '<', value: 160, phases: ['outward', 'hold'], severity: 1,
              message: 'Keep your right knee straight' },
            { id: 'leg_forward', metric: 'hip_flex_r', op: '>', value: 20, phases: ['outward', 'hold'], severity: 2,
              message: 'Lift the leg to the side, not forward' },
        ],
        steps: [
            'Stand tall facing the camera; hold a chair for balance if needed',
            'Keep your right knee straight and toes pointing forward',
            'Lift your right leg out to the side',
            'Hold briefly, then lower with control',
        ],
        cues: { outward: 'Lift a little higher', hold: 'Hold', return: 'Lower with control', rest: 'Lift your right leg to the side' },
    },
};

export const EXERCISE_IDS = Object.keys(EXERCISES);

// Legacy prescriptions stored only the display name.
const BY_NAME = Object.fromEntries(Object.values(EXERCISES).map(e => [e.name.toLowerCase(), e.id]));
BY_NAME['shoulder abduction (t-pose)'] = 'shoulder_abduction';

export function resolveExercise(idOrName) {
    if (!idOrName) return null;
    if (EXERCISES[idOrName]) return EXERCISES[idOrName];
    const id = BY_NAME[String(idOrName).toLowerCase()];
    return id ? EXERCISES[id] : null;
}

/** Progress along the prescribed range: 0 at rest, 1 at target. */
export function progressOf(cfg, value) {
    const span = cfg.targetValue - cfg.restValue;
    if (Math.abs(span) < 1e-9) return 0;
    return (value - cfg.restValue) / span;
}
