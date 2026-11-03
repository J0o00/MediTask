# DTW reference templates

Optional per-exercise reference curves, e.g. `squat.json`:

    { "exerciseId": "squat", "source": "therapist", "reps": 5, "progress": [0, 0.03, ... 30 values ...] }

Record them with `collect.html` -> "Save as DTW reference" from at least 3 correct repetitions performed
by a physiotherapist. Without a template the engine uses an idealised rest -> target -> hold -> rest
curve (`idealTemplate()` in js/intelligence/dtw-analyzer.js). Each session records which template was used.
