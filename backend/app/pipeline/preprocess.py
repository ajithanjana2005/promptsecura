"""Pre-processing stage (Phase 1).

Normalizes text so that later stages are harder to evade with trivial tricks:

* Unicode NFKC normalization (e.g. full-width "ｉｇｎｏｒｅ" -> "ignore").
* Removal of zero-width and bidirectional-control characters, which are
  invisible to the user but can split keywords. Their presence is counted
  and reported as a possible obfuscation signal.
* Removal of other control characters (newlines and tabs are kept).
* Whitespace cleanup.

Intent extraction is deliberately NOT implemented in Phase 1; see progress.md.
"""

from __future__ import annotations

import re
import unicodedata

from app.pipeline.base import PreprocessResult

# Zero-width characters, soft hyphen, word joiner, BOM, Mongolian vowel
# separator, and bidirectional embedding/override/isolate controls.
HIDDEN_CHARS: frozenset[str] = frozenset(
    {
        "\u00ad",  # soft hyphen
        "\u180e",  # Mongolian vowel separator
        "\u200b",  # zero width space
        "\u200c",  # zero width non-joiner
        "\u200d",  # zero width joiner
        "\u200e",  # left-to-right mark
        "\u200f",  # right-to-left mark
        "\u2060",  # word joiner
        "\ufeff",  # zero width no-break space / BOM
        *(chr(c) for c in range(0x202A, 0x202F)),  # LRE, RLE, PDF, LRO, RLO
        *(chr(c) for c in range(0x2066, 0x206A)),  # LRI, RLI, FSI, PDI
    }
)

_KEEP_CONTROL = frozenset({"\n", "\t"})
_HORIZONTAL_WS = re.compile(r"[ \t\u00a0]+")
_SPACE_AROUND_NEWLINE = re.compile(r" *\n *")
_MANY_NEWLINES = re.compile(r"\n{3,}")


def preprocess(text: str) -> PreprocessResult:
    original_length = len(text)

    normalized = unicodedata.normalize("NFKC", text)
    normalized = normalized.replace("\r\n", "\n").replace("\r", "\n")

    hidden_removed = 0
    control_removed = 0
    kept: list[str] = []
    for ch in normalized:
        if ch in HIDDEN_CHARS:
            hidden_removed += 1
            continue
        if unicodedata.category(ch) == "Cc" and ch not in _KEEP_CONTROL:
            control_removed += 1
            continue
        kept.append(ch)

    cleaned = "".join(kept)
    cleaned = _HORIZONTAL_WS.sub(" ", cleaned)
    cleaned = _SPACE_AROUND_NEWLINE.sub("\n", cleaned)
    cleaned = _MANY_NEWLINES.sub("\n\n", cleaned)
    cleaned = cleaned.strip()

    return PreprocessResult(
        text=cleaned,
        original_length=original_length,
        hidden_chars_removed=hidden_removed,
        control_chars_removed=control_removed,
    )
