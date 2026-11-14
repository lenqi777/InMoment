"""Group OCR rows into framed nodes and follow visible diagram connectors."""

from collections import defaultdict
from dataclasses import dataclass
from statistics import median

import cv2
import numpy as np


MAX_BOXES = 300
MAX_DEPTH = 10


@dataclass(frozen=True)
class Rect:
    x: int
    y: int
    width: int
    height: int

    @property
    def right(self):
        return self.x + self.width

    @property
    def bottom(self):
        return self.y + self.height

    @property
    def area(self):
        return self.width * self.height

    @property
    def center_y(self):
        return self.y + self.height / 2

    def overlap(self, other):
        return max(0, min(self.right, other.right) - max(self.x, other.x)) * max(
            0, min(self.bottom, other.bottom) - max(self.y, other.y)
        )


def text_regions(lines, scale):
    for line in lines:
        text = line['text'].strip()
        xs, ys = zip(*line['points'])
        x, y = round(min(xs) * scale), round(min(ys) * scale)
        width, height = round(max(xs) * scale) - x, round(max(ys) * scale) - y
        if text and width > 0 and height > 0:
            yield Rect(x, y, width, height), text


def rectangular_contours(mask, mode):
    contours, _ = cv2.findContours(mask, mode, cv2.CHAIN_APPROX_SIMPLE)
    for contour in contours:
        rect = Rect(*cv2.boundingRect(contour))
        if rect.width >= 20 and rect.height >= 12 and cv2.contourArea(contour) >= rect.area * .82:
            yield rect


def clipped_frames(mask):
    # A crop can cut across a text box. Close contours against the crop edge
    # for detection only. Later, connection tracing still uses original ink.
    height, width = mask.shape
    bordered = mask.copy()
    bordered[[0, -1], :] = 255
    bordered[:, [0, -1]] = 255
    for box in rectangular_contours(bordered, cv2.RETR_LIST):
        clipped_sides = sum((box.x <= 1, box.right >= width - 1, box.y <= 1, box.bottom >= height - 1))
        if 0 < clipped_sides <= 2:
            yield box


def candidate_frames(mask, text_height):
    # The inside of a thin border produces a rectangular hole. Filled title
    # nodes instead survive an opening that removes thin borders and connectors.
    kernel_size = max(5, round(text_height / 2) | 1)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (kernel_size, kernel_size))
    filled = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    yield from rectangular_contours(mask, cv2.RETR_LIST)
    yield from rectangular_contours(filled, cv2.RETR_EXTERNAL)
    yield from clipped_frames(mask)


def assign_rows(mask, rows, text_height):
    frames = []
    for candidate in sorted(set(candidate_frames(mask, text_height)), key=lambda box: (box.area, box.y, box.x)):
        if any(candidate.overlap(box) >= candidate.area * .85 for box, _ in frames):
            continue
        matches = [row for row in rows if candidate.overlap(row[0]) >= row[0].area * .8]
        if matches:
            frames.append((candidate, matches))
        if len(frames) > MAX_BOXES:
            return []
    owners = set()
    result = []
    for box, matches in frames:
        unique_rows = [row for row in matches if row not in owners]
        if unique_rows:
            result.append((box, merge_rows(unique_rows)))
            owners.update(unique_rows)
    return result


def merge_rows(rows):
    visual_rows = []
    for box, text in sorted(rows, key=lambda row: (row[0].center_y, row[0].x)):
        current = visual_rows[-1] if visual_rows else []
        if not current or abs(box.center_y - current[0][0].center_y) > min(box.height, current[0][0].height) * .35:
            visual_rows.append([(box, text)])
        else:
            current.append((box, text))

    def join(parts):
        result = ''
        previous = None
        for box, text in sorted(parts, key=lambda row: row[0].x):
            if previous and box.x - previous.right > min(box.height, previous.height) * .16:
                result += ' '
            result += text
            previous = box
        return result

    return [join(parts) for parts in visual_rows]


def connected_frames(mask, frames, text_height):
    height, width = mask.shape
    padding = max(3, min(7, round(text_height * .18)))
    wires = mask.copy()
    for box, _ in frames:
        wires[max(0, box.y - padding):box.bottom + padding, max(0, box.x - padding):box.right + padding] = 0
    _, labels, stats, _ = cv2.connectedComponentsWithStats(wires, connectivity=8)
    endpoints = defaultdict(lambda: (set(), set()))
    for index, (box, _) in enumerate(frames):
        # Ignore corners where fragments of the border could resemble wires.
        ys = slice(box.y + box.height // 8, box.bottom - box.height // 8)
        left = max(0, box.x - padding)
        right = min(width, box.right + padding)
        for side, xs in enumerate((slice(max(0, left - 3), left), slice(right, right + 3))):
            for label in np.unique(labels[ys, xs]):
                if label and stats[label, cv2.CC_STAT_AREA] >= 8:
                    endpoints[label][side].add(index)

    incoming = defaultdict(set)
    clipped = set()
    for label, (targets, sources) in endpoints.items():
        if len(sources) == 1:
            source = next(iter(sources))
            for target in targets:
                if frames[source][0].right < frames[target][0].x:
                    incoming[target].add(source)
        elif not sources:
            x, y, w, h, _ = stats[label]
            if x == 0 or y == 0 or y + h == height:
                clipped.update(targets)
        else:
            for target in targets:
                incoming[target].update(sources)
    parents = {child: next(iter(sources)) for child, sources in incoming.items() if len(sources) == 1}
    return parents, clipped


def arrange(frames, parents, clipped):
    if not frames:
        return None
    isolated_multiline = len(frames) == 1 and len(frames[0][1]) > 1
    if not parents and not isolated_multiline and not clipped:
        return None

    children = defaultdict(list)
    for child, parent in parents.items():
        children[parent].append(child)

    def reading_order(index):
        box = frames[index][0]
        return box.y, box.x

    def depth(index):
        return 1 + max((depth(child) for child in children[index]), default=0)

    def size(index):
        return 1 + sum(size(child) for child in children[index])

    def node(index):
        return {
            'lines': frames[index][1],
            'children': [node(child) for child in sorted(children[index], key=reading_order)],
        }

    components = set(range(len(frames))) - parents.keys()
    if any(depth(index) > MAX_DEPTH for index in components):
        return None
    primary = max(components, key=lambda index: (size(index), -frames[index][0].x, -frames[index][0].y))
    roots = {primary} | (components & clipped)
    return {
        'roots': [node(index) for index in sorted(roots, key=reading_order)],
        'unassigned': [node(index) for index in sorted(components - roots, key=reading_order)],
    }


def outline_from_image(png, lines):
    if len(lines) < 2:
        return None
    image = cv2.imdecode(np.frombuffer(png, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        return None
    height, width = image.shape[:2]
    scale = min(1, 2200 / max(height, width), (2_500_000 / (height * width)) ** .5)
    if scale < 1:
        image = cv2.resize(image, (max(1, round(width * scale)), max(1, round(height * scale))), interpolation=cv2.INTER_AREA)
    rows = list(text_regions(lines, scale))
    if len(rows) < 2:
        return None
    text_height = median(box.height for box, _ in rows)

    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    color = cv2.inRange(hsv, (0, 50, 55), (179, 255, 255))
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    dark_threshold, _ = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)
    dark = cv2.inRange(gray, 0, min(175, dark_threshold))
    best = (0, 0)
    outline = None
    for ink in (color, dark):
        mask = cv2.morphologyEx(ink, cv2.MORPH_CLOSE, np.ones((3, 3), dtype=np.uint8))
        frames = assign_rows(mask, rows, text_height)
        if not frames:
            continue
        parents, clipped = connected_frames(mask, frames, text_height)
        quality = (len(parents), len(frames))
        if quality > best and (candidate := arrange(frames, parents, clipped)):
            best, outline = quality, candidate
    return outline
