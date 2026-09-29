"""影像分割範本（Keras → model.h5）。輸出每個像素的類別，0 是背景。

設定（config.json）：
  image.resize         [高, 寬]（需為偶數）
  image.labels         前景類別名稱（順序對應遮罩值 1、2、…）
  augmentation         6 項；遮罩與影像套用同一個變換
  hyperparameters      epochs、batch_size、learning_rate、filters、augmentation_copies
  split、seed          以病例為單位切分
"""
from pathlib import Path

import numpy as np

import imagekit
import runtime


def build(keras, size, classes: int, filters: int, learning_rate: float):
    layers = keras.layers
    inputs = keras.Input(shape=(size[0], size[1], 1), name="image")
    down = layers.Conv2D(filters, 3, padding="same", activation="relu")(inputs)
    middle = layers.Conv2D(filters * 2, 3, padding="same", activation="relu")(layers.MaxPooling2D()(down))
    up = layers.Concatenate()([layers.UpSampling2D()(middle), down])
    up = layers.Conv2D(filters, 3, padding="same", activation="relu")(up)
    outputs = layers.Conv2D(classes, 1, activation="softmax", name="mask")(up)
    model = keras.Model(inputs, outputs, name="image_segmentation")
    model.compile(optimizer=keras.optimizers.Adam(learning_rate), loss="sparse_categorical_crossentropy",
                  metrics=["accuracy"])
    return model


def dice(predicted: np.ndarray, truth: np.ndarray, classes: int) -> float | None:
    scores = []
    for c in range(1, classes):
        p, t = predicted == c, truth == c
        if p.sum() + t.sum():
            scores.append(2 * (p & t).sum() / (p.sum() + t.sum()))
    return float(np.mean(scores)) if scores else None


def train(config: dict, data_dir: Path, out_dir: Path) -> dict:
    manifest = runtime.load_manifest(data_dir)
    size, augmentation = imagekit.image_config(config)
    if size[0] % 2 or size[1] % 2:
        raise ValueError("影像分割的 Resize 高與寬必須是偶數")
    labels = list((config.get("image") or {}).get("labels") or manifest.get("label_names") or [])
    if not labels:
        raise ValueError("影像分割至少需要 1 種前景類別")
    classes = len(labels) + 1
    samples = imagekit.load_samples(data_dir, manifest, size, want_mask=True)
    for s in samples:
        s["mask"] = np.where(s["mask"] < classes, s["mask"], 0).astype("int32")  # 未選的類別視為背景
    parts, splits = imagekit.split_samples(samples, config)
    hp = imagekit.hyper(config, epochs=3, batch_size=8, learning_rate=0.001, filters=8, augmentation_copies=1)
    training = imagekit.augment_training_set(parts["train"], augmentation, int(config["seed"]),
                                             int(hp["augmentation_copies"]))

    keras = imagekit.keras_setup(int(config["seed"]))
    model = build(keras, size, classes, int(hp["filters"]), float(hp["learning_rate"]))
    masks = lambda part: np.stack([s["mask"] for s in part]).astype("int32")  # noqa: E731
    model.fit(imagekit.stack(training), masks(training), epochs=int(hp["epochs"]),
              batch_size=int(hp["batch_size"]), shuffle=True, verbose=2)

    metrics = {"samples": {name: len(part) for name, part in parts.items()}, "training_samples": len(training)}
    for name, part in parts.items():
        if part:
            predicted = model.predict(imagekit.stack(part), verbose=0).argmax(axis=-1)
            truth = masks(part)
            metrics[name] = {"pixel_accuracy": float((predicted == truth).mean()),
                             "dice": dice(predicted, truth, classes)}
    imagekit.save_h5(model, out_dir)
    return runtime.finish(out_dir, config=config, manifest=manifest, model_file="model.h5", model_format="h5",
                          metrics=metrics, splits=splits, libraries=imagekit.LIBRARIES,
                          card={"label_names": labels, "input": {"resize": list(size), "normalise": "minmax"},
                                "augmentation": augmentation, "hyperparameters": hp})


if __name__ == "__main__":
    raise SystemExit(runtime.main(train))
