#!/usr/bin/env python3
"""Version-aware entry point for Waynode's pinned Hammersmith package."""
import sys

VERSION = "0.1.0"


def main() -> int:
    if sys.argv[1:] == ["--version"]:
        print(f"hammersmith {VERSION}")
        return 0
    from hammersmith.cli import main as upstream_main
    return int(upstream_main() or 0)


if __name__ == "__main__":
    raise SystemExit(main())
