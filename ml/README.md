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

The public-dataset loaders were written from the published descriptions without the files at hand. **Before the
first real run, open one file of each dataset and check the constants marked `VERIFY`** (column layout, joint order,
KIMORE score scale, REHAB24-6 exercise codes). The loaders print how many sequences/subjects they found per source.

## Keeping JS and Python in sync
Any change to features, metrics, normalisation, phase labels or DTW must be made in both languages. After editing
`exercise-configs.js` run `npm run export-configs`. `npm test` fails if the two implementations diverge.
