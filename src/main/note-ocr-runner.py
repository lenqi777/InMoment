"""Long-lived local OCR subprocess. Stdin carries length-prefixed PNG bytes."""

import json
import os
from pathlib import Path
import socket
import struct
import sys


MAX_IMAGE_BYTES = 32 * 1024 * 1024
MAX_LINES = 3000
MAX_SYMBOLS = 30000


def send(output, message):
    output.write(json.dumps(message, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
    output.write(b'\n')
    output.flush()


def deny_network(*_args, **_kwargs):
    raise RuntimeError('OCR runs offline')


def start(bundle):
    socket.create_connection = deny_network
    socket.socket.connect = deny_network
    socket.socket.connect_ex = deny_network
    sys.path.insert(0, str(bundle / 'site-packages'))
    import cv2
    from rapidocr import ModelType, OCRVersion, RapidOCR

    detector = bundle / 'models' / 'PP-OCRv6_det_small.onnx'
    recognizer = bundle / 'models' / 'PP-OCRv6_rec_small.onnx'
    if not detector.is_file() or not recognizer.is_file():
        raise FileNotFoundError('Local OCR models are missing')
    cv2.setNumThreads(1)
    engine = RapidOCR(params={
        'Global.use_cls': False,
        'Global.log_level': 'warning',
        'Det.ocr_version': OCRVersion.PPOCRV6,
        'Rec.ocr_version': OCRVersion.PPOCRV6,
        'Det.model_type': ModelType.SMALL,
        'Rec.model_type': ModelType.SMALL,
        'Det.model_path': str(detector),
        'Rec.model_path': str(recognizer),
        'EngineConfig.onnxruntime.intra_op_num_threads': 4,
        'EngineConfig.onnxruntime.inter_op_num_threads': 1,
    })
    # RapidOCR initializes these sessions lazily. Load them before accepting images
    # so missing/incompatible local resources are reported as a capability error.
    engine._load_det_model()
    engine._load_rec_model()
    return engine


def polygon(points):
    return [[int(x), int(y)] for x, y in points]


def recognize(ocr, image):
    result = ocr(image, return_word_box=True, return_single_char_box=True)
    if result.boxes is None or not result.txts:
        return []
    if len(result.txts) > MAX_LINES:
        raise OverflowError('Too many OCR lines')
    lines, count = [], 0
    for index, (text, points) in enumerate(zip(result.txts, result.boxes)):
        chars = []
        entries = result.word_results[index] if result.word_results and index < len(result.word_results) else ()
        # The library can omit word geometry and return a sentinel when it is unavailable.
        for entry in entries or ():
            if not isinstance(entry, (tuple, list)) or len(entry) != 3:
                continue
            char, _confidence, char_points = entry
            if char_points is not None and len(char_points) == 4:
                chars.append({'text': char, 'points': polygon(char_points)})
        count += len(chars)
        if count > MAX_SYMBOLS:
            raise OverflowError('Too many OCR characters')
        lines.append({'text': text, 'points': polygon(points), 'chars': chars})
    return lines


def serve(output):
    try:
        ocr = start(Path(sys.argv[1]))
        # Isolated Python excludes the script directory from its import path.
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from note_ocr_layout import outline_from_image
        from cv2 import error as LayoutError
    except Exception:
        send(output, {'error': 'capability'})
        return 1
    if sys.argv[2:] == ['--check']:
        send(output, {'ok': True})
        return 0

    stream = sys.stdin.buffer
    while header := stream.read(4):
        if len(header) != 4:
            return
        size = struct.unpack('>I', header)[0]
        if not 0 < size <= MAX_IMAGE_BYTES:
            send(output, {'error': 'recognize'})
            return
        image = stream.read(size)
        if len(image) != size:
            return
        try:
            lines = recognize(ocr, image)
            try:
                outline = outline_from_image(image, lines)
            except LayoutError:
                outline = None
            send(output, {'data': {'lines': lines, 'outline': outline}})
        except OverflowError:
            send(output, {'error': 'limit'})
        except Exception:
            send(output, {'error': 'recognize'})
    return 0


if __name__ == '__main__':
    with os.fdopen(os.dup(sys.stdout.fileno()), 'wb') as protocol:
        # Keep ordinary Python output and writes to fd 1 off the protocol pipe.
        os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
        sys.stdout = sys.stderr
        sys.exit(serve(protocol))
