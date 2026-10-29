"""Process-level helpers: resident memory and a polite scheduling priority."""
import os
import sys


def resident_mb():
    """Resident memory of this process in MB, or None when it cannot be read."""
    try:
        if sys.platform == "win32":
            import ctypes
            from ctypes import wintypes

            class Counters(ctypes.Structure):
                _fields_ = [
                    ("cb", wintypes.DWORD),
                    ("PageFaultCount", wintypes.DWORD),
                    ("PeakWorkingSetSize", ctypes.c_size_t),
                    ("WorkingSetSize", ctypes.c_size_t),
                    ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                    ("PagefileUsage", ctypes.c_size_t),
                    ("PeakPagefileUsage", ctypes.c_size_t),
                ]

            counters = Counters()
            counters.cb = ctypes.sizeof(counters)
            kernel = ctypes.WinDLL("kernel32")
            kernel.GetCurrentProcess.restype = wintypes.HANDLE
            psapi = ctypes.WinDLL("psapi")
            psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
            if not psapi.GetProcessMemoryInfo(kernel.GetCurrentProcess(), ctypes.byref(counters), counters.cb):
                return None
            return round(counters.WorkingSetSize / 1048576, 1)
        if sys.platform.startswith("linux"):
            with open("/proc/self/statm") as handle:
                pages = int(handle.read().split()[1])
            return round(pages * os.sysconf("SC_PAGE_SIZE") / 1048576, 1)
        import resource

        usage = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        # macOS reports bytes (a peak, not current, but the closest portable figure).
        return round(usage / 1048576, 1)
    except Exception:
        return None


def lower_priority():
    """Run below normal priority, so a model loading here never competes with the
    viewer drawing it. Best effort; failure is harmless."""
    try:
        if sys.platform == "win32":
            import ctypes

            BELOW_NORMAL_PRIORITY_CLASS = 0x00004000
            kernel = ctypes.WinDLL("kernel32")
            kernel.GetCurrentProcess.restype = ctypes.c_void_p
            kernel.SetPriorityClass(ctypes.c_void_p(kernel.GetCurrentProcess()), BELOW_NORMAL_PRIORITY_CLASS)
        else:
            os.nice(5)
    except Exception:
        pass
