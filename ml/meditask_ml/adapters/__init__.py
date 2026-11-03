from . import meditask_custom, public_datasets, synthetic

LOADERS = {
    "meditask_custom": meditask_custom.load,
    "kimore": public_datasets.load_kimore,
    "ui_prmd": public_datasets.load_ui_prmd,
    "rehab24_6": public_datasets.load_rehab24_6,
    "manifest": public_datasets.load_manifest,
    "synthetic": synthetic.load,
}
