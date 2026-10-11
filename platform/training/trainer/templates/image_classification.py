"""影像分類範本（Keras → model.h5）。

設定（config.json）：
  image.resize         [高, 寬]
  image.labels         要納入的 Label（順序即類別編號）；不在清單內的影像不參與訓練
  augmentation         旋轉、長寬位移、Shear、Zoom、水平翻轉、垂直翻轉
  hyperparameters      epochs、batch_size、learning_rate、filters、augmentation_copies
  split、seed          訓練／驗證／測試比例與亂數種子（以研究為單位切分）
"""
from pathlib import Path

import numpy as np

import imagekit
import runtime


def build(keras, size, classes: int, filters: int, learning_rate: float):
    layers = keras.layers
    model = keras.Sequential([
        keras.Input(shape=(size[0], size[1], 1), name="image"),
        layers.Conv2D(filters, 3, padding="same", activation="relu"),
        layers.MaxPooling2D(),
        layers.Conv2D(filters * 2, 3, padding="same", activation="relu"),
        layers.GlobalAveragePooling2D(),
        layers.Dense(classes, activation="softmax", name="label"),
    ], name="image_classification")
    model.compile(optimizer=keras.optimizers.Adam(learning_rate), loss="sparse_categorical_crossentropy",
                  metrics=["accuracy"])
    return model


def train(config: dict, data_dir: Path, out_dir: Path) -> dict:
    manifest = runtime.load_manifest(data_dir)
    size, augmentation = imagekit.image_config(config)
    labels = list((config.get("image") or {}).get("labels") or manifest.get("label_names") or [])
    if len(labels) < 2:
        raise ValueError("影像分類至少需要 2 種 Label")
    samples = [s for s in imagekit.load_samples(data_dir, manifest, size) if s["label"] in labels]
    if not samples:
        raise ValueError("沒有任何影像帶有選定的 Label")
    parts, splits = imagekit.split_samples(samples, config)
    hp = imagekit.hyper(config, epochs=3, batch_size=8, learning_rate=0.001, filters=8, augmentation_copies=1)
    training = imagekit.augment_training_set(parts["train"], augmentation, int(config["seed"]),
                                             int(hp["augmentation_copies"]))

    keras = imagekit.keras_setup(int(config["seed"]))
    model = build(keras, size, len(labels), int(hp["filters"]), float(hp["learning_rate"]))
    target = lambda part: np.array([labels.index(s["label"]) for s in part], dtype="int32")  # noqa: E731
    model.fit(imagekit.stack(training), target(training), epochs=int(hp["epochs"]),
              batch_size=int(hp["batch_size"]), shuffle=True, verbose=2)

    metrics = {"samples": {name: len(part) for name, part in parts.items()}, "training_samples": len(training)}
    for name, part in parts.items():
        if part:
            predicted = model.predict(imagekit.stack(part), verbose=0).argmax(axis=1)
            metrics[name] = {"accuracy": float((predicted == target(part)).mean())}
    imagekit.save_h5(model, out_dir)
    return runtime.finish(out_dir, config=config, manifest=manifest, model_file="model.h5", model_format="h5",
                          metrics=metrics, splits=splits, libraries=imagekit.LIBRARIES,
                          card={**imagekit.device_info(), "label_names": labels,
                                "input": {"resize": list(size), "normalise": "minmax"},
                                "augmentation": augmentation, "hyperparameters": hp})


if __name__ == "__main__":
    raise SystemExit(runtime.main(train))
