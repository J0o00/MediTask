# MediTask ML pipeline

Temporal movement intelligence: multi-task GRU/LSTM models predicting **exercise**, **movement quality**
(correct / incorrect / incomplete) and **per-frame phase** from one repetition (30 frames × 82 features).

```
ml/
├── config/
│   ├── exercises.json        GENERATED from js/rehabilitation/exercise-configs.js (npm run export-configs)
│   ├── label_taxonomy.json   common exercise classes + per-dataset code maps (check VERIFY notes)
│   └── datasets.json         which sources to load and where
├── meditask_ml/
│   ├── skeleton.py metrics.py features.py segmentation.py dtw.py rules.py   (mirrors of the JS engine)
│   ├── adapters/             kimore, ui_prmd, rehab24_6 / manifest, meditask_custom, synthetic
│   ├── dataset.py            build arrays + participant-wise 70/10/20 split
│   ├── augment.py            train-only augmentation
│   ├── models.py train.py evaluate.py run_experiments.py export_web.py
├── scripts/  extract_pose.py (videos → landmarks), make_parity_fixtures.py
├── notebooks/MediTask_Train_Colab.ipynb
└── data/raw/{kimore,ui_prmd,rehab24_6,meditask_custom}/    put datasets here (not committed)
```

## Run

```bash
cd ml
pip install -r requirements.txt

# 1. data (put the downloaded datasets under data/raw/, see below)
python -m meditask_ml.dataset                      # -> data/processed/, prints progress toward 6,000

# 2. all models + baselines, report, export best to ../models/web/
python -m meditask_ml.run_experiments

# single model
python -m meditask_ml.train --arch gru --features hybrid --name gru_hybrid

# 3. prove browser parity for the exported model, then from the repo root: npm test
python scripts/make_parity_fixtures.py --model models/$(cat reports/selected_model.txt)
```

No data yet? `python -m meditask_ml.dataset --synthetic --out data/processed_synthetic` then pass
`--data data/processed_synthetic --quick` — this only proves the code runs.

## Datasets
| Folder | Get it from | Loader expects |
|---|---|---|
| `data/raw/kimore` | KIMORE (Univ. Politecnica delle Marche) | `.../<subject>/Es<k>/Raw/JointPosition*.csv`, `.../Label/ClinicalAssessment*` |
| `data/raw/ui_prmd` | https://webpages.uidaho.edu/ui-prmd/ | `Segmented Movements/Kinect/Positions/mXX_sXX_eXX_positions.txt` and the `Incorrect Segmented Movements` equivalent |
| `data/raw/rehab24_6` | REHAB24-6 publication (Masaryk University) | `manifest.csv` you write — see `manifest.example.csv` and `load_manifest()` |
| `data/raw/meditask_custom` | `collect.html` exports | `*.json`, format `meditask-sequences-v1` |
| any video | your recordings | `scripts/extract_pose.py` → `.npy` + `manifest.csv` → add a `manifest` source |

### How the shipped model was trained (November 2026)
* **UI-PRMD** (PDDL licence), Kinect positions plus angles, from a GitHub mirror of the official release.
  * The Kinect positions are relative to each joint's parent. `uiprmd_forward_kinematics()` rebuilds world
    coordinates from the angle files (Rz·Ry·Rx), following the dataset authors' reference code.
  * Shoulder abduction (m07) is right-arm only, so it is mapped to the `arm_abduction` class.
* **REHAB24-6** (CC0), from the standardised CSVs (`rehab246_*_positions_standardized.csv` + `Segmentation.csv`).
  * The CSVs give a single hip joint, so the left and right hips are approximated at ±0.25 × shoulder width.
  * Repetitions flagged `mocap_erroneous` are excluded.
* **KIMORE** is not included. The only reachable copy has joint angles but not the positions this pipeline needs.
* Command: `python -m meditask_ml.dataset` (sources in `config/datasets.json`), then
  `python -m meditask_ml.run_experiments --epochs 80 --augment 1`, then
  `python -m meditask_ml.export_web --model models/gru_coords`.
* The raw and processed data are **not** in the project zip (370 MB). Download them again into `data/raw/` to retrain.
* `config/label_taxonomy.json → app_exercise_to_model_class` decides which app exercises use the model.
  The app shows the model's quality verdict only where its test accuracy for that exercise was at least 65%
  (`quality_by_exercise` in the exported manifest).

## Keeping JS and Python in sync
Any change to features, metrics, normalisation, phase labels or DTW must be made in both languages. After editing
`exercise-configs.js` run `npm run export-configs`. `npm test` fails if the two implementations diverge.
