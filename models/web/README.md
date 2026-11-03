# Browser model

`meditask_model.json` + `meditask_model.bin` is the deployed model: **gru_coords**. It was trained on 3,057 real
repetitions from 20 people (UI-PRMD + REHAB24-6) with a participant-wise split. Results on held-out patients:
exercise macro-F1 0.98, correct/incorrect accuracy 0.72. Full report: `ml/reports/results.md`.

* The manifest field `app_exercise_to_model_class` lists which app exercises the model covers.
* The field `quality_by_exercise` holds the test accuracy for each exercise. The app shows the model's quality
  verdict only where that accuracy is at least 0.65. Today that means the lateral leg raise.

If you delete these files, the app runs in **rule-based mode** (biomechanical rules + DTW only).
To replace the model, run `cd ml && python -m meditask_ml.export_web --model models/<name>`.
