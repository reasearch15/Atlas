import cv2
import numpy as np

from .errors import QrGenerationError


def generate_png(payload: str) -> bytes:
    if not payload or not payload.startswith("PYECASH-POC-NONPAYABLE:"):
        raise QrGenerationError("missing or unsafe synthetic payment payload")
    try:
        matrix = cv2.QRCodeEncoder_create().encode(payload)
        bordered = cv2.copyMakeBorder(matrix, 4, 4, 4, 4, cv2.BORDER_CONSTANT, value=255)
        image = cv2.resize(bordered, None, fx=8, fy=8, interpolation=cv2.INTER_NEAREST)
        ok, encoded = cv2.imencode(".png", image)
        if not ok:
            raise QrGenerationError("OpenCV could not encode PNG")
        return encoded.tobytes()
    except QrGenerationError:
        raise
    except Exception as exc:
        raise QrGenerationError("QR generation failed") from exc


def decode_png(png: bytes) -> str:
    if not png:
        raise QrGenerationError("empty QR image")
    image = cv2.imdecode(np.frombuffer(png, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
    if image is None:
        raise QrGenerationError("invalid PNG")
    decoded, _, _ = cv2.QRCodeDetector().detectAndDecode(image)
    if not decoded:
        raise QrGenerationError("QR could not be decoded")
    return decoded
