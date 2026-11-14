"""Red / green board for the v3 items.

  python scripts/tdd_status.py            # show the board
  python scripts/tdd_status.py --check    # what CI runs: old tests must pass, and nothing listed
                                          # in tests/v3_green.txt may go red again

An item is finished when its test module passes AND its name is in tests/v3_green.txt.
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GREEN_FILE = ROOT / "tests" / "v3_green.txt"


def passes(*args):
    return subprocess.run([sys.executable, "-m", "unittest", *args], cwd=ROOT, capture_output=True, text=True).returncode == 0


def main():
    check = "--check" in sys.argv
    locked = {l.strip() for l in GREEN_FILE.read_text().splitlines() if l.strip() and not l.startswith("#")}
    old_ok = passes("discover", "-s", "tests", "-p", "test_[!v]*.py")
    print(f"{'GREEN' if old_ok else 'RED  '}  existing tests (everything that is not test_v3_*)")
    broken = [] if old_ok else ["existing tests"]
    nxt = None
    for f in sorted((ROOT / "tests").glob("test_v3_*.py")):
        name = f.stem
        ok = passes(f"tests.{name}")
        note = ""
        if name in locked and not ok:
            note = "  <-- was finished, now broken: fix this first"
            broken.append(name)
        elif name not in locked and ok:
            note = "  <-- passing: add it to tests/v3_green.txt in your green commit"
        elif not ok and nxt is None:
            nxt = name
        print(f"{'GREEN' if ok else 'RED  '}  {name}{note}")
    if nxt and not broken:
        print(f"\nNext: {nxt}  ->  python -m unittest tests.{nxt} -v   (spec: docs/PLAN-v3.md)")
    if broken:
        print("\nBroken: " + ", ".join(broken))
    if check and broken:
        sys.exit(1)


if __name__ == "__main__":
    main()
