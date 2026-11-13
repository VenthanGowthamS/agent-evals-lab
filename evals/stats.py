"""Small-sample statistics. Five trials is a thin sample; show the range, not only the point."""
from math import sqrt


def wilson(passes, n, z=1.96):
    """95% Wilson score interval for a pass rate. Returns (low, high) as fractions."""
    if n == 0:
        return 0.0, 1.0
    p = passes / n
    d = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / d
    half = z * sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return max(0.0, centre - half), min(1.0, centre + half)
