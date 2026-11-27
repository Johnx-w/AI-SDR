"""Hold a private kill-on-close Job for the worker and its browser tree."""

import ctypes as c
from ctypes import wintypes as w
import runpy
import sys


class BasicLimit(c.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", c.c_int64),
        ("PerJobUserTimeLimit", c.c_int64),
        ("LimitFlags", w.DWORD),
        ("MinimumWorkingSetSize", c.c_size_t),
        ("MaximumWorkingSetSize", c.c_size_t),
        ("ActiveProcessLimit", w.DWORD),
        ("Affinity", c.c_size_t),
        ("PriorityClass", w.DWORD),
        ("SchedulingClass", w.DWORD),
    ]


class ExtendedLimit(c.Structure):
    _fields_ = [
        ("BasicLimitInformation", BasicLimit),
        ("IoInfo", c.c_uint64 * 6),
        ("ProcessMemoryLimit", c.c_size_t),
        ("JobMemoryLimit", c.c_size_t),
        ("PeakProcessMemoryUsed", c.c_size_t),
        ("PeakJobMemoryUsed", c.c_size_t),
    ]


kernel = c.WinDLL("kernel32", use_last_error=True)
kernel.CreateJobObjectW.argtypes = [c.c_void_p, w.LPCWSTR]
kernel.CreateJobObjectW.restype = w.HANDLE
kernel.SetInformationJobObject.argtypes = [w.HANDLE, c.c_int, c.c_void_p, w.DWORD]
kernel.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
kernel.GetCurrentProcess.restype = w.HANDLE

job = kernel.CreateJobObjectW(None, None)
limits = ExtendedLimit()
limits.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
if (
    not job
    or not kernel.SetInformationJobObject(job, 9, c.byref(limits), c.sizeof(limits))
    or not kernel.AssignProcessToJobObject(job, kernel.GetCurrentProcess())
):
    sys.exit(125)

sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name="__main__")
