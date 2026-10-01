"""Run from the project's isolated Windows Python without modifying its ._pth file."""

from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from python_backend.server import main  # noqa: E402

if __name__ == "__main__":
    main()
