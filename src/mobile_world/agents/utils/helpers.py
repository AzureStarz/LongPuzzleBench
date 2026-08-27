"""Image helpers for multimodal model requests."""

from __future__ import annotations

import base64
from io import BytesIO

from PIL import Image


def pil_to_base64(image: Image.Image | bytes) -> str:
    """Encode a PIL image or image bytes as PNG base64."""

    if not isinstance(image, Image.Image):
        image = Image.open(BytesIO(image)).convert("RGB")
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("utf-8")


def pil_adaptive_resize(
    image: Image.Image, max_dimension: int = 2576
) -> tuple[Image.Image, float, float]:
    """Resize only when the longest image side exceeds ``max_dimension``."""

    original_width, original_height = image.size
    if max(original_width, original_height) <= max_dimension:
        return image, 1.0, 1.0
    scale = max_dimension / max(original_width, original_height)
    target = (round(original_width * scale), round(original_height * scale))
    resized = image.resize(target, Image.Resampling.LANCZOS)
    return resized, original_width / target[0], original_height / target[1]
