"""
Blended print ETA.

Progress-based estimates (elapsed / progress) are garbage for the first chunk of
a print: first layers run slow, heat-soak and probing eat time, and a 1% reading
can swing the answer by hours. Slicer estimates are stable but drift on machines
tuned faster or slower than the slicer profile.

So: start from the slicer number, and hand over to the measured rate as the
print proves itself. By ~30% progress the measured rate dominates.
"""
from dataclasses import dataclass
from typing import Optional

HANDOVER_PROGRESS = 0.30


@dataclass
class EtaResult:
    seconds_left: Optional[int]
    source: Optional[str]       # 'slicer' | 'progress' | 'blended' | 'printer'
    confidence: Optional[str]   # 'low' | 'medium' | 'high'


def blend_eta(progress: float, elapsed: float, slicer_total: Optional[float],
              printer_reported_left: Optional[float] = None) -> EtaResult:
    """
    progress: 0..1 fraction complete
    elapsed: seconds of actual printing so far
    slicer_total: slicer's estimated total print time (seconds), if known
    printer_reported_left: firmware/host-reported remaining seconds (e.g. OctoPrint), if known
    """
    p = max(0.0, min(1.0, progress or 0.0))
    if p >= 0.999:
        return EtaResult(0, "progress", "high")

    progress_left: Optional[float] = None
    if p >= 0.01 and elapsed > 0:
        progress_left = max(0.0, elapsed / p - elapsed)

    slicer_left: Optional[float] = None
    if slicer_total and slicer_total > 0:
        slicer_left = max(0.0, slicer_total * (1.0 - p))

    # Host-reported estimate (OctoPrint's own model) beats a naive progress ratio.
    if printer_reported_left and printer_reported_left > 0 and slicer_left is None:
        conf = "high" if p >= 0.25 else "medium" if p >= 0.05 else "low"
        return EtaResult(int(printer_reported_left), "printer", conf)

    if slicer_left is not None and progress_left is not None:
        w = min(1.0, p / HANDOVER_PROGRESS)
        left = (1.0 - w) * slicer_left + w * progress_left
        conf = "high" if p >= HANDOVER_PROGRESS else "medium"
        return EtaResult(int(left), "blended" if w < 1.0 else "progress", conf)

    if slicer_left is not None:
        return EtaResult(int(slicer_left), "slicer", "medium")

    if progress_left is not None:
        conf = "high" if p >= 0.25 else "medium" if p >= 0.05 else "low"
        return EtaResult(int(progress_left), "progress", conf)

    return EtaResult(None, None, None)
