"""Shared synthetic 3D image + label volume (used by NIfTI and ITK outputs)."""

import numpy as np

SHAPE = (32, 32, 16)  # x, y, z
SPACING = (1.5, 1.5, 3.0)


def make_case(r: np.random.Generator, index: int) -> tuple[np.ndarray, np.ndarray, list[int]]:
    """Return (image int16, label uint8, foreground classes); 1 class on even
    indices, 2 classes on odd ones, so both variants are always covered."""
    n_classes = 1 + (index % 2)
    x, y, z = np.meshgrid(*(np.arange(n) for n in SHAPE), indexing="ij")
    image = r.normal(100, 20, size=SHAPE)
    label = np.zeros(SHAPE, dtype=np.uint8)
    for cls in range(1, n_classes + 1):
        c = r.integers([8, 8, 4], [24, 24, 12])
        rad = int(r.integers(4, 7))
        mask = ((x - c[0]) ** 2 + (y - c[1]) ** 2 + ((z - c[2]) * 2) ** 2) < rad**2
        label[mask] = cls
        image[mask] += 150 * cls
    return np.round(image).astype(np.int16), label, list(range(1, n_classes + 1))
