"""CLI: uv run python -m synth <command> --out DIR [--seed N]"""

import argparse
import sys
from pathlib import Path

from . import clinical, dicom, itk, makesense, nifti, tabular, vitals
from .common import DEFAULT_SEED, write_manifest


def _all(out: Path, seed: int) -> dict:
    steps = {
        "dicom": lambda d: dicom.generate(d, seed, studies=20),
        "nifti": lambda d: nifti.generate(d, seed, count=3),
        "itk": lambda d: itk.generate(d, seed, count=3),
        "makesense": lambda d: makesense.generate(d, seed, count=3),
        "tabular": lambda d: tabular.generate(d, seed),
        "clinical": lambda d: clinical.generate(d, seed),
        "vitals": lambda d: vitals.generate(d, seed, count=100),
    }
    outputs = {}
    for kind, step in steps.items():
        manifest = step(out / kind)
        outputs[kind] = {"dir": kind, "counts": manifest["counts"]}
    return write_manifest(out, {"kind": "all", "seed": seed, "outputs": outputs})


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m synth", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    def add(name, help_, **counts):
        p = sub.add_parser(name, help=help_)
        p.add_argument("--out", type=Path, required=True)
        p.add_argument("--seed", type=int, default=DEFAULT_SEED)
        for flag, default in counts.items():
            p.add_argument(f"--{flag}", type=int, default=default)

    add("dicom", "CT/MR DICOM studies", studies=20)
    add("nifti", "NIfTI image/label pairs", count=3)
    add("itk", "ITK .mha image/label pairs", count=3)
    add("makesense", "makesense.ai COCO exports", count=3)
    add("tabular", "cohort CSVs, schema.json, bad.csv")
    add("clinical", "HL7 v2 / JSON / SQL / CSV FHIR sources")
    add("vitals", "monitor readings (JSON lines)", count=100)
    add("all", "everything, one subfolder per command")

    a = parser.parse_args(argv)
    if a.seed < 0:
        parser.error("--seed must be >= 0")
    if a.command == "dicom":
        m = dicom.generate(a.out, a.seed, studies=a.studies)
    elif a.command == "nifti":
        m = nifti.generate(a.out, a.seed, count=a.count)
    elif a.command == "itk":
        m = itk.generate(a.out, a.seed, count=a.count)
    elif a.command == "makesense":
        m = makesense.generate(a.out, a.seed, count=a.count)
    elif a.command == "tabular":
        m = tabular.generate(a.out, a.seed)
    elif a.command == "clinical":
        m = clinical.generate(a.out, a.seed)
    elif a.command == "vitals":
        m = vitals.generate(a.out, a.seed, count=a.count)
    else:
        m = _all(a.out, a.seed)
    print(f"{a.command}: wrote {a.out / 'manifest.json'} counts={m.get('counts', m.get('outputs'))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
