#!/usr/bin/env python3
"""Generate reference predictions for the JavaScript emulator gate.

Emits TWO references per parameter vector, because they answer two different
questions:

``expected``
    The released ``predict.py`` in full float64. The browser cannot match this
    exactly -- it reads float32 arrays -- so the gap is a PHYSICAL budget
    (~2e-3 dex, far below one plot pixel), reported but not gated tightly.

``expected_web``
    The same arithmetic on the float32 arrays the browser actually downloads,
    accumulated in float64 (which is the only precision JavaScript has). This
    is what the port must reproduce EXACTLY, so it is gated at machine level.

Without the second one the gate is useless: a genuine port bug of a few times
1e-3 dex would hide inside the quantisation budget, and the page would keep
drawing a plausible, wrong curve.

    python3 tools/check_js_emulator.py \\
        --predict /path/to/01_emulator/predict.py \\
        --src     /path/to/01_emulator \\
        --out     /tmp/cases.json
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import pathlib

import numpy as np

QUANTITIES = ("qlf", "bhmf", "cerdf", "qhmf")

F32 = np.float32


def _predict_web(emu, theta):
    """Reproduce the browser exactly: float32 storage, float64 arithmetic."""
    q = lambda a: np.asarray(F32(a), dtype=np.float64)   # quantise, then widen
    xs = (np.asarray(theta, float) - emu.scaler_mean) / emu.scaler_scale
    X, alpha = q(emu.X_train), q(emu.alpha)
    w = np.empty(alpha.shape[0])
    for i in range(alpha.shape[0]):
        d = xs[None, :] - X
        r2 = np.sum(d * d / emu.kernel_metric[i], axis=-1)
        r = np.sqrt(np.maximum(r2, 0.0))
        a = np.sqrt(3.0) * r
        w[i] = emu.gp_mean[i] + emu.kernel_amplitude[i] * (((1 + a) * np.exp(-a)) @ alpha[i])
    return w @ q(emu.pca_components) + q(emu.pca_mean) + emu.floor_value


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--predict", type=pathlib.Path, required=True,
                    help="path to the released predict.py")
    ap.add_argument("--src", type=pathlib.Path, required=True,
                    help="directory of emulator_<quantity>.hdf5")
    ap.add_argument("--out", type=pathlib.Path, required=True)
    ap.add_argument("--n", type=int, default=8, help="vectors per quantity")
    args = ap.parse_args()

    spec = importlib.util.spec_from_file_location("release_predict", args.predict)
    ref = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ref)

    rng = np.random.default_rng(20260827)
    cases: dict[str, list] = {}
    for q in QUANTITIES:
        emu = ref.load(str(args.src / f"emulator_{q}.hdf5"))
        lo, hi = emu.param_ranges[:, 0], emu.param_ranges[:, 1]
        entries = []
        for k in range(args.n):
            # include the two corners and the centre, then sample the interior
            if k == 0:
                theta = lo.copy()
            elif k == 1:
                theta = hi.copy()
            elif k == 2:
                theta = 0.5 * (lo + hi)
            else:
                theta = lo + rng.random(len(lo)) * (hi - lo)
            y = ref.predict(emu, theta, check_bounds=False)[0].ravel()
            yw = _predict_web(emu, theta)
            entries.append({"theta": [float(v) for v in theta],
                            "expected": [float(v) for v in y],
                            "expected_web": [float(v) for v in yw]})
        cases[q] = entries
        print(f"  {q:6s} {len(entries)} vectors, {len(entries[0]['expected'])} outputs each")

    args.out.write_text(json.dumps(cases))
    print(f"  wrote {args.out} ({args.out.stat().st_size / 1024 / 1024:.1f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
