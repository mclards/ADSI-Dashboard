# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_all

datas = [('drivers', 'drivers'), ('shared_data.py', '.'), ('ipconfig.json', '.')]
binaries = []
hiddenimports = ['drivers.modbus_tcp', 'uvicorn.loops.asyncio', 'uvicorn.lifespan.off', 'uvicorn.protocols.http.h11_impl', 'anyio._backends._asyncio', 'pydantic.v1.datetime_parse']
tmp_ret = collect_all('pymodbus')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]


a = Analysis(
    ['InverterCoreService.py'],
    pathex=[],
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
    name='InverterCoreService',
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
