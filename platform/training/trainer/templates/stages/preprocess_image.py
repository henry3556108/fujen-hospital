"""資料清理與前處理環節（影像）：Resize 與資料增強。

平台預設：每張影像縮放到 preprocess.json 的 resize，訓練資料再依 augmentation 做增強，
每張原始影像另外產生 augmentation_copies 份。驗證與測試資料不增強。

可以修改 augment_training_set（例如換一種增強方式）。
prepare_image 不能修改：推論服務用平台的版本處理影像，改了會讓訓練與推論不一致。
"""
import numpy

import imagekit


def prepare_image(image: numpy.ndarray, size: tuple[int, int], config: dict) -> numpy.ndarray:
    return imagekit.prepare_image(image, size)


def augment_training_set(samples: list[dict], config: dict, seed: int) -> list[dict]:
    """samples：訓練樣本（每筆含 image，分割另有 mask、偵測另有 boxes）；config：augmentation、augmentation_copies。
    回傳原始樣本加上增強後的樣本。"""
    return imagekit.augment_samples(samples, config["augmentation"], seed, config["augmentation_copies"])
