# -*- mode: python ; coding: utf-8 -*-
import os
from PyInstaller.utils.hooks import collect_all

SPEC_PATH = os.path.abspath(
    globals().get("__file__", os.path.join(os.getcwd(), "services", "ForecastCoreService.spec"))
)
BASE_DIR = os.path.abspath(os.path.dirname(SPEC_PATH))
ROOT_DIR = os.path.abspath(os.path.join(BASE_DIR, ".."))

datas = []
binaries = []
hiddenimports = []

for pkg in (
    "numpy",
    "pandas",
    "scipy",
    "sklearn",
    "joblib",
    "requests",
):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

a = Analysis(
    [os.path.join(ROOT_DIR, "ForecastCoreService.py")],
    pathex=[ROOT_DIR],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="ForecastCoreService",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
