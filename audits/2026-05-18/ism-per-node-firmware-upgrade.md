# ISM Per-Node Inverter Firmware Upgrade — Reverse-Engineering Report

**Date:** 2026-05-18
**Status:** Complete — authoritative, decoded byte-for-byte from ISM .NET IL
**Scope:** How INGECON SUN Manager (ISM) flashes inverter (power-stage DSP)
firmware per Modbus node, using `docs/AAV1003IJK01BC_InverterFirmware.S`
**Author:** Reverse-engineering session (Claude)
**Method:** 32-bit PowerShell + System.Reflection IL disassembly of
`d:\ADSI-Dashboard\_ism\IngeconSunManager.exe`,
`d:\ADSI-Dashboard\_ism\FV.IngeBLL.dll`,
`C:\Users\User\Desktop\INGECON SUN Manager\FV.Transport-AAX1009IJA04.dll`,
`d:\ADSI-Dashboard\_ism\FV.IngeBLL.Base.dll`. Tooling:
`d:\ADSI-Dashboard\_spike\ism_load.ps1`, `_spike\ism_il.ps1`,
`_spike\ism_fw_scan.ps1` (raw IL dumps: `_spike\fw_*.txt`).

> This is an **internal study only**. The ADSI Dashboard does **not** implement
> firmware upgrade and this report does not propose adding it. It documents the
> vendor protocol so future inverter-integration work (register decode, safety
> gating, alarm correlation) has ground truth, and so we never accidentally
> collide with the vendor's flash command codes.

---

## 1. The firmware file: `AAV1003IJK01BC_InverterFirmware.S`

Standard **Motorola S-record (SREC)**, 1626 lines:

| Record | Count | Meaning |
|---|---|---|
| `S0` | 1 | Header. Address `0x0000`, ASCII payload `PROGRAM&DATA`. |
| `S3` | 1624 | 32-bit-address data records (mostly 76 hex data bytes each). |
| `S7` | 1 | Termination, 32-bit start address **`0x0000B153`**. |

After interval-merging the S3 addresses, the image targets **4 disjoint
regions** (byte addresses):

| Region | Range | Size | Maps to (DSP807 flash map, §6) |
|---|---|---|---|
| Main program | `0x000004 – 0x00DFEC` | ~57 KB | P-flash `0x0004–0x7fff` + `0x8000–0xefff` |
| Boot / vectors | `0x00F800 – 0x00FE1A` | ~1.5 KB | P-flash `0xf800–0xffff` |
| X data bank A | `0x200040 – 0x200188` | 328 B | X-flash (addr − `0x200000`) |
| X data bank B | `0x202000 – 0x2029CC` | ~2.5 KB | X-flash `0x2000–0x3fff` |

`0x200000`-based addresses are **X (data) flash**; everything else is
**P (program) flash** (see `RellenaDatosFlash`, §5.3). Each DSP56F 16-bit word
is stored as a byte pair and recombined little-endian. `0xFFFF` = erased/blank
(skipped). Filename encodes the firmware code: `AAV1003` (compatibility key) +
`IJK01` (main-app variant; `IJK03` = reboot/companion variant) + `BC` (version).

---

## 2. Architecture / call chain

The user's INGECON SUN PowerMax three-phase units are, in the ISM type
hierarchy:

```
Trifasico : DSP807_Display : DSP807 : FreescaleDSP56F : arch : Ingecon
```

`.S` files are only valid for the **Freescale DSP56F** family
(`ImportSFile` throws `NotImplementedException` for `targetDSP` 4/5 = Texas /
CortexM3; `.bin`/`.hex` are the other DSP families' formats).

Two UI entry points, same engine:

| UI form | Where | Method |
|---|---|---|
| `frmFirmware` (advanced) | Online ▸ per-machine firmware | `CargarFirmware_Click → ProcesoDeCarga` |
| `frmFirmwareSAT` (Tools tab — **the screenshot**) | Tools ▸ Start Firmware Upgrade | `CargarFirmware_Click → UpgradeFirmwareDeIngecon` |

Both converge on:

```
FreescaleDSP56F.UpgradeFirmware(folder, forceDowngrade, _)
   → arch.DameUnicoFicheroFirmware(folder,".S",compat,false)   // pick THE file
   → arch.VerificaFicheroFirmware(path)                        // verify code
   → Isla.loader (Cargador).ImportSFile(node,path,Micro,len,Set50)  // build frames
   → Isla.loader.Cargar(retries=4)                             // flash the node
        → CargarYTalVezCambiaElBirtate(retries)
              → iTransport.modbusQR(frame,0)  ×N                // wire send/recv
```

`Isla.loader` is **one shared `Cargador` per plant** — nodes are flashed
**strictly sequentially**, never in parallel.

---

## 3. "Per-node" = per Modbus slave address

`frmFirmware.GetDireccionesParaActualizarDesdeTreeview() : byte[]`
(decoded from IL):

1. Finds the plant treeview control `tvwPlanta`.
2. For each `TreeViewMS` (multi-select tree) → `SelectedNodes`.
3. For each selected `TreeNode`: `byte.TryParse(node.Text, out addr)`.
4. Returns the list of parsed **Modbus node addresses**.

So the tree in the screenshot (`INV 02` ▸ nodes `1 2 3 4`) maps node text
directly to the Modbus slave address. `frmFirmwareSAT` uses the equivalent
`Ws.IDselected` (selected IDs); empty selection ⇒ *"Please select at least one
Ingecon"*.

`ProcesoDeCarga`/`UpgradeFirmwareDeIngecon` then **loop over the address
array**, and for each `nodo`:

```
switch (tipoFicheroFirmware mifirm):           # file type
   .S  → loader.ImportSFile(nodo, path, miDSP, longTrama, checkTrama50.Checked)
   .bin→ loader.ImportBinFile(nodo, path, miDSP)
   .hex→ loader.ImportHexFile(nodo, path, miDSP, longTrama)
if   miDSP == 8 : loader.CargarFirmwareTexas(path, nodo, skipSerial)
elif miDSP == 9 : loader.CargarFirmwareDisplaySobreCANTexas(path)
else            : loader.FlagParcheTrama50 = checkTrama50.Checked
                  loader.Cargar(numIntentos)        # ← FreescaleDSP56F path
Isla.Add( Ingecon.Identifica(transport, nodo, 0) )  # re-identify, refresh tree
```

`nodo == 0` is **broadcast** (all nodes at once); DSP supports it, CortexM3
explicitly does not (*"CortexM3 does not support broadcast firmware upload"*).
Broadcast paces itself via `BroadcastPideEsperar`.

Tunables on `frmFirmware` (defaults shown):
- `Combo_LongTrama` → `longTrama` (firmware payload bytes per data frame),
  **default 1024**. The Tools/`FreescaleDSP56F.UpgradeFirmware` path hard-codes
  **512**.
- `Combo_NumIntentos` → `numIntentos` (retry attempts), **default 4**.
- `checkTrama50` checkbox → see §7.

---

## 4. File selection, identity & mismatch protection
(matches the screenshot's numbered instructions)

`arch.DameUnicoFicheroFirmware(folder, ".S", FirmwaresCompatibles, Reboot=false)`:

- `Directory.GetFiles(folder,"*.S")`; each filename (no ext, upper-cased) must
  match `LLLnnnn…` or → *"Some firmware filenames are not correct. Must start
  with LLLnnnn…"*.
- Keep files whose 7-char prefix (e.g. `AAV1003`) is in the inverter's
  `FirmwaresCompatibles` list **and** (since `Reboot=false`) the name contains
  `IJK01` (boot files `BF/BE/BI/BK` matched on a 6-char prefix instead).
- **0 matches** → `CargaDeFirmwareException` *"No firmware found for INGECON SUN
  {node}. Compatible firmwares are: …"*.
- **>1 match** → `IOException` *"Too many firmwares found for INGECON SUN
  {node}: …"* — **this is exactly the screenshot warning**: "INGECON SUN
  Manager will NOT upgrade a INGECON if it finds more than one compatible
  firmware".
- Exactly 1 → returns that path.

`FreescaleDSP56F.VerificaFicheroFirmware(path)` then opens the `.S` and scans
for the line at `get_PosicionDelCodigoFirmwareEnFichero()` (a DSP-class-specific
flash address; `DSP803`/`DSP807` override it), extracts the embedded firmware
code, endian-inverts it, and asserts it equals the code derived from the
**filename**. Mismatch → *"Invalid firmware"*. This is the anti-"wrong file"
guard ("please make sure that you copy the right one").

Version gating: `Ingecon.QueHableAhoraOCalleParaSiempre(newCode, forceDowngrade)`
compares running `CFirmware.Version` vs the file's version and emits *"will be
upgraded"* / *"will be **downgraded**"* (downgrade requires the force flag;
`IngeconFwUpdateHelper.CheckCanUpgradeFirmware` enforces boot-code/downgrade
rules). Unknown serial ⇒ *"…assuming serial no… will be flashed with…"*.

---

## 5. Frame construction (`Cargador`)

`ImportSFile` **pre-builds the entire frame sequence** into
`FirmwareEnTramas : ArrayList<byte[]>` before any I/O:

```
[0]            = CrearTrama0x90(Set50)            # START
[1 .. N]       = CrearTrama0x91(Set50) (×NumTramasTotal, AvanzaFlash between)
[N+1]          = CrearTrama0x92(Set50)            # END / global checksum
```

`NumTramasTotal` (`CalculaCantidadTramas`): per flash bank,
`ceil(Data_count / longTrama)`, summed over P-flash (struct[1]), optional
external/P-flash-2 (struct[2]) and X-flash (struct[0]).

### 5.1 START — `CrearTrama0x90(to50)` → 6 bytes
```
[0]=node   [1]= to50 ? 0x50 : 0x90   [2..5]=0
```
Pure "begin firmware download" announcement. Transport adds CRC (§8).

### 5.2 DATA — `CrearTrama0x91(to51)`
```
[0] = node
[1] = to51 ? 0x51 : 0x91
[2] = (_dirFlash / 256) & 0xFF      # flash word-address, high
[3] = (_dirFlash % 256) & 0xFF      # flash word-address, low
[4] = (ByteCount / 256) & 0xFF      # payload length, high
[5] = (ByteCount % 256) & 0xFF      # payload length, low
[6..] = data words from FLASH_STRUCT[bank].data[],
        each 16-bit word emitted as 2 bytes: word/256, word%256
[+]  = TipoMemoria                  # program/data/external memory selector byte
[last]= XOR of all preceding bytes, then % 256   # firmware-level checksum
```
The first data frame additionally carries the **page-erase map** so the DSP
erases only the needed 256-word pages before writing.

### 5.3 END — `CrearTrama0x92(to52)`
```
chk = Calculo_CheckSum_Global()      # checksum over the whole flashed image
[0]=node  [1]= to52 ? 0x52 : 0x92  [2]=chk/256  [3]=chk%256  [last]=XOR%256
```

### 5.4 SPEED — `CrearTrama0x96()` → 6 bytes `[node, 0x96, 0,0,0,0]`
Serial only: asks the DSP whether it accepts a higher line rate.

### 5.5 S-record parsing
- `ValidaLineaDeSFile`: declared byte-count must equal actual; SREC checksum =
  `0xFF − (Σ count+addr+data bytes) mod 256` must match the last byte. Every
  `S0/S3/S?` line is validated; failure → *"Error in S0/S3/S? line"*.
- `RellenaDatosFlash`: `addr = u32(line[4:12])`, words `= (count−5)/2`; each word
  `= u8(line[12+4i:+2]) + u8(line[14+4i:+2])·256`; if `addr ≥ 0x200000` →
  X-flash (`addr−=0x200000`) else P-flash; word stored into
  `FLASH_STRUCT[idx].data[addr−Flash_start]`; non-duplicate pages flagged in
  `Page_erase_map`.
- `DirFlash_2_IndexFlashstruct`: maps an address+memtype to the FLASH_STRUCT
  bank whose `[Flash_start, Flash_end]` contains it.

---

## 6. DSP flash memory map (`CargaMapaFlashDSP80x`)

Hard-coded per DSP class. For `argDSP ∈ {1,6}` (DSP807-class — our units), the
banks (`flags Flash_start Flash_end FlashType addr …pageEraseParams`):

```
"0 1 0x2000 0x3fff 0 0x1360 …"   # X data-flash 0x2000–0x3fff
"0 0 0x0004 0x7fff 1 0x1340 …"   # P prog-flash 0x0004–0x7fff
"0 0 0x8000 0xefff 1 0x1420 …"   # P prog-flash 0x8000–0xefff
"0 0 0xf800 0xffff 1 0x1380 …"   # P boot/vectors 0xf800–0xffff
"0 0 0x0000 0x0003 1 0x1380 …"   # P reset vector 0x0000–0x0003
```
(DSP803-class uses `0x1000–0x1fff` etc.) These ranges **exactly cover** the 4
S-record regions in §1 — confirming `AAV1003IJK01BC` is a DSP807-class image.
`_dirFlash` starts at `0xEFFF`, falling back to `0x7FFF` if that bank is empty.

---

## 7. The "Before 2009 three-phase models" checkbox

`checkTrama50.Checked` →
`Cargador.FlagParcheTrama50` and `ImportSFile(... Set50Trama)`. When **true**,
every command code is shifted down by `0x40`:

| Phase | Modern (≥2009) | Pre-2009 (`FlagParcheTrama50`) |
|---|---|---|
| Start | `0x90` | `0x50` |
| Data  | `0x91` | `0x51` |
| End   | `0x92` | `0x52` |

Older three-phase units run a bootloader that expects the `0x5x` function
codes; the box re-targets the same payloads to the legacy opcodes. It also
**disables the §8 high-speed step** (`FlagParcheTrama50` short-circuits the
`0x96` probe). `frmFirmwareSAT` exposes the same idea as
`UpgradeFirmwareDeIngecon(displayAntiguo, fuerzaDowngrade)`.

---

## 8. Wire protocol & timing (`Cargar` → `CargarYTalVezCambiaElBirtate`)

Transport is `iTransport.modbusQR(byte[] pdu, 0)` (FV.IngeModbusDAL) — the
`Cargador` builds the raw `[node,func,…,XOR]` PDU and the transport wraps it:
**Modbus RTU CRC16** for serial (`Add_CRC`/`auchCRCHi/Lo` tables) or **MBAP
header** for Modbus-TCP. Reply lands in `iTransport.bTramaRx`. (The strings
`PeticionCargaFirmware`, `EnvioTramaFirmware`, `FinCargaFirmware`,
`PeticionCargaFirmwareAltaVelocidad` in FV.Transport are log/diagnostic tags
for these same exchanges, not a separate path.)

Sequence for a FreescaleDSP56F node:

1. **(serial only, not pre-2009, argDSP∈{1,2,3})** send `0x96`; if reply
   `[1]==echo, [2]==0` → *"DSP allow higher bitrate. Changed"*, set serial
   `BaudRate = 38400`; else *"DSP does not allow higher bitrate"*. Retried up
   to `numIntentos`. (CortexM3 path instead does `Bridge2Transparent`; HMS/
   Anybus path does `HMSRequireMaster`.)
2. No reply at all → `SalDePuenteSiProcede` + `CargaDeFirmwareException`
   *"Target did not reply to firmware update request"*.
3. Send `FirmwareEnTramas[0]` (**0x90**). Accept when reply func ==
   `Set50?0x50:0x90` and `bTramaRx[2]==0`. Codes: `[2]==1`→*"…start (0x90)
   error code 1"*, `[2]==2`→*"…error code 2"*.
4. *"Target accepted firmware update request"* → *"Waiting for 5 seconds"* →
   `Thread.Sleep(5000)` (DSP mass-erase).
5. **Data loop** over frames `1..N` (**0x91**): `modbusQR`; the **first** data
   frame waits an extra `Thread.Sleep(5000)` (*"First frame requires longer
   pause to allow complete flash erase"*). Reply status `bTramaRx[2]`:
   - `0` → *"ACK"*, advance.
   - `1` → *"NACK - frame checksum error"*, `Sleep(600)`, **resend same frame**
     (frame-checksum-error counter++).
   - `2` → *"DSP 'error 2' processing frame"*, `Sleep(400)`, retry
     (flash-error counter++).
   - `3` → `CargaDeFirmwareException` *"Unexpected 'error 3' in firmware load"*.
   - timeout → `Sleep(1000)`, no-reply counter++; per-frame retry bounded by
     `numIntentos`.
6. After all data frames, validate the prebuilt last frame's func ==
   `Set50?0x52:0x92` (else *"Missing end-of-firmware frame!"*); send **0x92**
   (*"Sending Global Checksum"*). Status `3` → *"Global checksum error"*; no
   reply → `GlobalChecksumException` *"Target did not reply to
   end-of-firmware request"*.
7. Success → *"Firmware loaded correctly …"* → `Sleep(3000)` →
   `SalDePuenteSiProcede` (leave bridge if used); HMS path `Sleep(4000)` +
   `HMSFreeMaster`.
8. **`Cargar` `finally` always restores serial `BaudRate = 9600`** (even on
   exception) — so a failed high-speed attempt never leaves the bus at 38400.
9. Total-failure diagnostic string:
   `NoReplies:n   FrameCHKErrors:n   FlashErrors:n   RXFrameError:n`.

After each node the loop calls `Ingecon.Identifica(transport, nodo, 0)` and
`Isla.Add(...)` to re-read identity/version and refresh the tree row.

---

## 9. Key facts / implications for ADSI

- **Per-node = per Modbus slave address, sequential, one shared `Cargador`.**
  Multi-node "INV 02 ▸ 1 2 3 4" = a loop, not parallelism.
- **Command codes `0x90/0x91/0x92/0x96` (and legacy `0x50/0x51/0x52`) are the
  vendor firmware opcodes.** Our Modbus integration must **never** emit these
  function codes; they are not standard Modbus FCs. Document them as reserved.
- The flash protocol carries its **own XOR checksum inside the PDU**, *plus*
  the transport's Modbus RTU CRC16 / MBAP — two independent integrity layers.
- The S-record's embedded firmware-code line (at the DSP-class flash position)
  is the authoritative version, cross-checked against the filename. Useful if
  we ever need to read/verify firmware identity from a register dump.
- Long blocking sleeps (5 s erase, 5 s first frame, 3 s finalize) + baud
  switching mean a firmware session monopolises the RS-485 bus for minutes per
  node and **must not** overlap our poller. (We do not flash; just don't be
  surprised by bus silence during a field-service ISM session.)
- Pre-2009 three-phase units are a real, separate opcode dialect — relevant if
  the plant ever mixes generations.

## 10. Decode tooling (reusable)

`d:\ADSI-Dashboard\_spike\` (gitignored scratch):
- `ism_load.ps1` — recursion-proof 32-bit reflection loader (closure-captured
  `HashSet` guard; `$script:` scope does **not** bind inside a .NET event
  delegate → StackOverflow without it).
- `ism_il.ps1` — `-Find <regex>` locates declaring types; `-Targets
  "T::M;T2::*"` disassembles IL with token/string resolution.
- `ism_fw_scan.ps1` — surface scan by regex over all ISM assemblies.
- Raw dumps: `fw_frm.txt`, `fw_eng1.txt`, `fw_tramas.txt`, `fw_arch.txt`,
  `ism_fw_scan.txt`.
Hashtable lookups must cast the IL byte to `[int]` — .NET `Hashtable` treats
`Byte 115 ≠ Int32 115`.
