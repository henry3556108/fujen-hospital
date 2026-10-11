"""物件偵測範本（Keras → model.h5）。

極小的示範模型：每張影像固定預測 max_boxes 個位置，每個位置輸出方框與類別（類別 0 表示沒有物件）。
標註的方框依面積由大到小填入各位置。輸出：
  box    (max_boxes, 4)  [x, y, 寬, 高]，以影像寬高正規化到 0–1
  label  (max_boxes, 類別數 + 1) 的機率

設定（config.json）：
  image.resize         [高, 寬]
  image.labels         要納入的 Label（順序即類別編號，從 1 起算）
  augmentation         6 項；方框與影像套用同一個變換
  hyperparameters      epochs、batch_size、learning_rate、filters、max_boxes、augmentation_copies
  split、seed          以研究為單位切分
"""
from pathlib import Path

import numpy as np

import imagekit
import runtime


def build(keras, size, classes: int, slots: int, filters: int, learning_rate: float):
    layers = keras.layers
    inputs = keras.Input(shape=(size[0], size[1], 1), name="image")
    x = layers.Conv2D(filters, 3, padding="same", activation="relu")(inputs)
    x = layers.MaxPooling2D()(x)
    x = layers.Conv2D(filters * 2, 3, padding="same", activation="relu")(x)
    x = layers.GlobalAveragePooling2D()(x)
    box = layers.Reshape((slots, 4), name="box")(layers.Dense(slots * 4, activation="sigmoid")(x))
    label = layers.Softmax(name="label")(layers.Reshape((slots, classes))(layers.Dense(slots * classes)(x)))
    model = keras.Model(inputs, {"box": box, "label": label}, name="image_detection")
    model.compile(optimizer=keras.optimizers.Adam(learning_rate),
                  # 用損失物件而不是字串 "mse"：Keras 3 從 H5 還原字串 "mse" 會失敗，平台外就載不回來
                  loss={"box": keras.losses.MeanSquaredError(),
                        "label": keras.losses.SparseCategoricalCrossentropy()})
    return model


def targets(part: list[dict], labels: list[str], slots: int, size) -> tuple[np.ndarray, np.ndarray]:
    boxes = np.zeros((len(part), slots, 4), dtype="float32")
    classes = np.zeros((len(part), slots), dtype="int32")
    for i, sample in enumerate(part):
        wanted = [b for b in sample.get("boxes") or [] if b["label"] in labels]
        wanted.sort(key=lambda b: (-b["bbox"][2] * b["bbox"][3], b["bbox"][0], b["bbox"][1]))
        for k, b in enumerate(wanted[:slots]):
            x, y, w, h = b["bbox"]
            boxes[i, k] = [x / size[1], y / size[0], w / size[1], h / size[0]]
            classes[i, k] = labels.index(b["label"]) + 1
    return boxes, classes


def iou(a: np.ndarray, b: np.ndarray) -> float:
    x0, y0 = max(a[0], b[0]), max(a[1], b[1])
    x1, y1 = min(a[0] + a[2], b[0] + b[2]), min(a[1] + a[3], b[1] + b[3])
    inter = max(0.0, x1 - x0) * max(0.0, y1 - y0)
    union = a[2] * a[3] + b[2] * b[3] - inter
    return float(inter / union) if union > 0 else 0.0


def train(config: dict, data_dir: Path, out_dir: Path) -> dict:
    manifest = runtime.load_manifest(data_dir)
    size, augmentation = imagekit.image_config(config)
    labels = list((config.get("image") or {}).get("labels") or manifest.get("label_names") or [])
    if not labels:
        raise ValueError("物件偵測至少需要 1 種 Label")
    samples = imagekit.load_samples(data_dir, manifest, size, want_boxes=True)
    parts, splits = imagekit.split_samples(samples, config)
    hp = imagekit.hyper(config, epochs=3, batch_size=8, learning_rate=0.001, filters=8, max_boxes=2,
                        augmentation_copies=1)
    slots = int(hp["max_boxes"])
    training = imagekit.augment_training_set(parts["train"], augmentation, int(config["seed"]),
                                             int(hp["augmentation_copies"]))

    keras = imagekit.keras_setup(int(config["seed"]))
    model = build(keras, size, len(labels) + 1, slots, int(hp["filters"]), float(hp["learning_rate"]))
    box_t, label_t = targets(training, labels, slots, size)
    model.fit(imagekit.stack(training), {"box": box_t, "label": label_t}, epochs=int(hp["epochs"]),
              batch_size=int(hp["batch_size"]), shuffle=True, verbose=2)

    metrics = {"samples": {name: len(part) for name, part in parts.items()}, "training_samples": len(training)}
    for name, part in parts.items():
        if part:
            out = model.predict(imagekit.stack(part), verbose=0)
            box_t, label_t = targets(part, labels, slots, size)
            present = label_t > 0
            ious = [iou(out["box"][i, k], box_t[i, k]) for i, k in zip(*np.nonzero(present))]
            metrics[name] = {"mean_iou": float(np.mean(ious)) if ious else None,
                             "label_accuracy": float((out["label"].argmax(axis=-1) == label_t).mean())}
    imagekit.save_h5(model, out_dir)
    return runtime.finish(out_dir, config=config, manifest=manifest, model_file="model.h5", model_format="h5",
                          metrics=metrics, splits=splits, libraries=imagekit.LIBRARIES,
                          card={**imagekit.device_info(), "label_names": labels, "max_boxes": slots,
                                "input": {"resize": list(size), "normalise": "minmax"},
                                "augmentation": augmentation, "hyperparameters": hp})


if __name__ == "__main__":
    raise SystemExit(runtime.main(train))
