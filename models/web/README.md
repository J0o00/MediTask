# Browser model

Place the exported model here:

    meditask_model.json   architecture, labels, feature statistics, weight offsets
    meditask_model.bin    float32 weights

Produce them with `python -m meditask_ml.run_experiments` (exports the best model on validation
quality macro-F1) or `python -m meditask_ml.export_web --model ml/models/<name>`.

When these files are absent the app runs in **rule-based mode** (biomechanical rules + DTW only).
No model is shipped by default on purpose: a model trained on synthetic smoke-test data must not be
used with patients. Run `npm test` after adding a model; regenerate the parity fixtures first
(`ml/scripts/make_parity_fixtures.py --model ml/models/<name>`).
