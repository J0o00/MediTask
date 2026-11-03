"""Extract MediaPipe pose landmarks from exercise videos (RGB sources such as
KIMORE/REHAB24-6 videos or your own recordings) for the manifest loader.

    python scripts/extract_pose.py --videos data/raw/my_videos --out data/raw/my_videos_pose \
        --model pose_landmarker_full.task

Download the model file once from
https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker (pose_landmarker_full.task).

For every video writes <name>.npy with shape (frames, 33, 4) = world x, y, z, visibility,
and appends a row to manifest.csv (layout=mediapipe33, y_down=1, segmented=0) which you
then complete with subject / exercise / quality.
"""
from __future__ import annotations

import argparse
import csv
from pathlib import Path

import numpy as np


def extract(video: Path, model: Path):
    import cv2
    import mediapipe as mp
    from mediapipe.tasks import python as mpt
    from mediapipe.tasks.python import vision

    opts = vision.PoseLandmarkerOptions(base_options=mpt.BaseOptions(model_asset_path=str(model)),
                                        running_mode=vision.RunningMode.VIDEO, num_poses=1,
                                        min_pose_detection_confidence=0.5, min_tracking_confidence=0.5)
    cap = cv2.VideoCapture(str(video))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    frames, i = [], 0
    with vision.PoseLandmarker.create_from_options(opts) as lm:
        while True:
            ok, img = cap.read()
            if not ok:
                break
            res = lm.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(img, cv2.COLOR_BGR2RGB)),
                                      int(i * 1000 / fps))
            if res.pose_world_landmarks:
                w, im = res.pose_world_landmarks[0], res.pose_landmarks[0]
                frames.append([[p.x, p.y, p.z, im[k].visibility] for k, p in enumerate(w)])
            else:
                frames.append([[np.nan] * 4] * 33)
            i += 1
    cap.release()
    arr = np.array(frames, dtype=np.float32)
    # forward-fill frames without a detection (short gaps), drop leading empties
    ok = ~np.isnan(arr[:, 0, 0])
    if not ok.any():
        return None, fps
    first = int(np.argmax(ok))
    arr = arr[first:]
    for t in range(1, len(arr)):
        if np.isnan(arr[t, 0, 0]):
            arr[t] = arr[t - 1]; arr[t, :, 3] = 0.0
    return arr, fps


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--videos", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", required=True)
    a = ap.parse_args()
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    man = out / "manifest.csv"
    new = not man.exists()
    with man.open("a", newline="") as fh:
        w = csv.writer(fh)
        if new:
            w.writerow(["file", "subject", "exercise", "quality", "layout", "fps", "y_down", "segmented"])
        for v in sorted(Path(a.videos).glob("*")):
            if v.suffix.lower() not in {".mp4", ".avi", ".mov", ".mkv"}:
                continue
            arr, fps = extract(v, Path(a.model))
            if arr is None:
                print(f"no person detected in {v.name}")
                continue
            np.save(out / f"{v.stem}.npy", arr[:, :, :3])
            w.writerow([f"{v.stem}.npy", "TODO", "TODO", "TODO", "mediapipe33", round(fps, 2), 1, 0])
            print(f"{v.name}: {len(arr)} frames @ {fps:.1f} fps")
    print(f"Fill in subject/exercise/quality in {man}, then add it as a 'manifest' source in config/datasets.json")


if __name__ == "__main__":
    main()
