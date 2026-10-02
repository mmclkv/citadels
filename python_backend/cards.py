"""Static game data and deterministic card helpers, with no JavaScript runtime dependency."""

from __future__ import annotations

import json
from pathlib import Path

_catalog = json.loads((Path(__file__).with_name("catalog.json")).read_text(encoding="utf-8"))
COLORS = _catalog["colors"]
DISTRICTS = _catalog["districts"]
CHARACTERS = _catalog["characters"]
CHAR_MAP = {character["id"]: character for character in CHARACTERS}
