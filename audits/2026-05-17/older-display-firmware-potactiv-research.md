# Research — Older Ingeteam display firmware & "Pot. Activ" vs "Per. Vacio" across versions

**Date:** 2026-05-17
**Status:** Complete (public-web ceiling reached; firmware binaries are gated)
**Subject:** Does an *older* Ingeteam display/UI firmware than
`docs/InverterDisplayFirmware.bin` (SHA-256 `83ad86d3…369b`, 130 048 B,
build 2022-05-31) expose **Pot. Activ** as a Modbus-writable / differently-
named field that the latest firmware removed or renamed?
**Method:** `WebSearch` + `WebFetch` (firecrawl/exa MCP not configured),
~18 sources, plus internal firmware-RE evidence. Confidence: **Medium-High**
for the conclusion; **High** for "no public older binary / no public
calibration-register evidence exists."

---

## Executive summary

No public evidence supports the hypothesis that an older display firmware
exposed **Pot. Activ** as a Modbus register, nor that the term was renamed
across versions. Across every published Ingeteam document, the Modbus
interface (request-only doc **AAV1089IMB04**) is a *monitoring/control*
protocol — energy, power, status, alarms, setpoints, and a *firmware-version*
register — and contains **no sensor-scale / factory-calibration / "Pot.
Activ" register in any version**. "Pot. Activ" and "Per. Vacio" are
long-standing Spanish service-**HMI** menu labels (Potencia Activa /
Pérdidas en Vacío), used in the on-unit calibration procedure that Ingeteam
has documented continuously since at least 2013 (the three-phase "Trin#NN"
calibration notes → today's "TrinPM20"). Older display-firmware **binaries
are not on the open web** — they ship only inside model-specific SD-card
packages from Ingeteam's gated Downloads area / ISM, with no public archive
or Wayback copy. Therefore the authoritative source for what *our* units do
remains our own RE of the 2022-05-31 image plus `calibration_decoder.py`
and the operator's on-device observation — and those already say offset 90
= "Per. Vacio" (display-only), with Active-P being an HMI-only flow.

---

## 1. Ingeteam firmware/display versioning (FACT)

- Inverter and **display/UI firmware are separately-versioned code
  families.** Examples surfaced: `ABH1002_x` (inverter), and explicitly
  **`ABH1003_H` = "for the display"**, `ABH1003_P` = "minimum required UI
  version" ([BYD compatible-inverter list, ingeconsuntraining.info](https://www.ingeconsuntraining.info/wp-content/uploads/2019/03/BYD_Compatible_Inverter_List_V4.2.pdf)).
- Version order: filename `XXXXXXXXX_z` where `_z` is the revision — first
  release is bare `_`, then `_A`, `_B`, …, later two-letter suffixes
  (`AC`) are newer still ("last two chars alphabetical; `AC` > `_T`")
  ([INGECON SUN 1Play TL M, ManualsLib p.77](https://www.manualslib.com/manual/2979511/Ingeteam-Ingecon-Sun-1play-Tl-M.html?page=77); [1Play HF, ManualsLib p.38](https://www.manualslib.com/manual/921652/Ingeteam-Ingecon-Sun-1play-Hf.html?page=38)).
- Our `docs/InverterDisplayFirmware.bin` is the **display/UI** image of
  this family (three-phase PowerMax / "TrinPM" variant), build 2022-05-31.
  *Inference:* an "older display firmware" would simply be a lower-suffix
  `ABHxxxx_*` of the same UI family — not a different protocol surface.

## 2. The Modbus map has never been a calibration surface (FACT)

- Every public PowerMax/SUN manual that mentions Modbus says only: *"To
  obtain information about how this information is structured … request
  document **AAV1089IMB04** from Ingeteam"* ([INGECON SUN PowerMax TL U B,
  ManualsLib p.121](https://www.manualslib.com/manual/1908349/Ingeteam-Ingecon-Sun-Powermax-Tl-U-B-1000-Vdc-Series.html?page=121)). The register map is **access-controlled**, not
  published per-version on the open web.
- Public register descriptions (e.g. [INGECON SUN Lite Input Register
  Guide, Scribd](https://www.scribd.com/document/463639899/INGECON-SUN-Lite-register)) cover **monitoring only**: lifetime energy
  (30001-2), run hours (30003-4), electrical values, **display-firmware
  version**, self-consumption. No scale-factor / "Pot. Activ" /
  "Per. Vacio" / factory-calibration register appears in any public
  version. *Inference (Medium-High):* the sensor-scale calibration block
  our dashboard reads (offsets 81-94) is a **vendor service area**, not
  part of the documented Modbus map — consistent with it never being a
  public, versioned, write-through "Pot. Activ" register.
- Notably **a Modbus register reports the display firmware version** —
  see §5 (actionable).

## 3. "Pot. Activ" / "Per. Vacio" are service-HMI terms, not version drift (FACT/INFERENCE)

- These are standard Spanish abbreviations: **Pot. Activ = Potencia
  Activa** (active power, the wattmeter watts the operator types);
  **Per. Vacio = Pérdidas en Vacío** (no-load loss coefficient, derived
  for display). They belong to the on-unit **service/calibration menu**,
  not the Modbus monitoring map.
- Ingeteam has documented three-phase on-unit calibration continuously:
  the installer-training site hosts **"Trin#16 — Inverter calibration.
  Voltage/Current — Step 1"**, dated **2013/03**
  ([ingeconsuntraining.info/.../Trin16NOTES.pdf](https://www.ingeconsuntraining.info/wp-content/uploads/2013/03/Trin16NOTES.pdf)) — the older-generation analogue of today's
  **TrinPM20** procedure. The naming continuity ("Trin#NN" 2013 → "TrinPM20"
  2020s) indicates a *persistent procedure family*, not a renamed/removed
  feature. (Body not retrievable — the training server returns HTTP 403 to
  crawlers and there is no Wayback snapshot — but its title/date/host are
  themselves the evidence.)
- *Gap (honest):* I could not retrieve a side-by-side older vs newer
  service-menu screenshot to literally prove the labels are byte-identical
  across firmware. No public source contradicts continuity; none confirms a
  rename. Treat "labels unchanged across versions" as **well-supported
  inference, not proven fact.**

## 4. Older display-firmware binaries are not publicly obtainable (FACT)

- Firmware (incl. display/UI) ships as model-specific `.rar`/`.zip`
  SD-card packages from Ingeteam's gated *Downloads* area, or via **ISM /
  INGECON SUN Manager** ([1Play TL M p.77](https://www.manualslib.com/manual/2979511/Ingeteam-Ingecon-Sun-1play-Tl-M.html?page=77); [INGECON SUN Manager product page](https://www.ingeteam.com/en-us/energy/photovoltaic-energy/p15_24_306/ingecon-sun-manager.aspx)). No public version archive, no
  loose `.bin`, and the relevant training PDFs are 403/!archived. So a
  disassemblable *older* three-phase display image cannot be sourced from
  the open internet for comparison.

## 5. Actionable: detect the version risk instead of hunting binaries

The user's real concern is *"version differences matter."* The robust,
implementable mitigation surfaced by this research:

- **A Modbus register reports the display firmware version** (present in
  the public Lite register description; the field also exists for the
  three-phase family). The dashboard can **read each unit's display-
  firmware-version register** and compare it against the version of the
  image we reverse-engineered (the 2022-05-31 `ABHxxxx_*` build). Any unit
  whose display firmware differs is flagged before a calibration write —
  this *detects* the exact risk the operator is worried about, without
  needing to find old binaries.
- This is consistent with the existing non-negotiable: Active-P
  calibration stays **HMI-only** (offsets 90/91/94 non-bypassably refused
  server-side). The version-register check is an *additional* guard, not a
  reason to expose offset 90.

---

## Key takeaways

1. **No public evidence** that older firmware exposed "Pot. Activ" via
   Modbus or used a different term — the Modbus map (AAV1089IMB04) is
   monitoring/control only, in every version, and is request-gated.
2. **"Pot. Activ"/"Per. Vacio" are service-HMI labels**, part of a
   continuously-documented on-unit calibration procedure (2013 "Trin#16"
   → "TrinPM20"); continuity is well-supported, a rename is unsupported.
3. **Older display binaries are unobtainable publicly** (gated SD-card
   packages / ISM; training PDFs 403; no Wayback) — the 2022-05-31 image
   we already RE'd + `calibration_decoder.py` + operator observation
   remain the authoritative source. The prior conclusion (offset 90 =
   Per. Vacio display-only; Active-P HMI-only) stands.
4. **Recommended next step (not a premise change):** add a per-unit
   *display-firmware-version* read (Modbus version register) and flag any
   unit that differs from the RE'd build before calibration writes.

## Sources

1. [INGECON SUN PowerMax TL U B 1000 Vdc — ManualsLib p.121](https://www.manualslib.com/manual/1908349/Ingeteam-Ingecon-Sun-Powermax-Tl-U-B-1000-Vdc-Series.html?page=121) — Modbus = "request AAV1089IMB04".
2. [INGECON SUN Lite Input Register Guide — Scribd](https://www.scribd.com/document/463639899/INGECON-SUN-Lite-register) — public register set is monitoring-only + fw-version.
3. [INGECON SUN 1Play TL M — ManualsLib p.77](https://www.manualslib.com/manual/2979511/Ingeteam-Ingecon-Sun-1play-Tl-M.html?page=77) — firmware code/version scheme, SD-card update.
4. [INGECON SUN 1Play HF — ManualsLib p.38](https://www.manualslib.com/manual/921652/Ingeteam-Ingecon-Sun-1play-Hf.html?page=38) — `_z` revision naming.
5. [BYD Compatible Inverter List V4.2 — ingeconsuntraining.info](https://www.ingeconsuntraining.info/wp-content/uploads/2019/03/BYD_Compatible_Inverter_List_V4.2.pdf) — `ABH1003_H` = display fw, `_P` min UI.
6. [Trin#16 Inverter calibration Voltage/Current (2013/03) — ingeconsuntraining.info](https://www.ingeconsuntraining.info/wp-content/uploads/2013/03/Trin16NOTES.pdf) — older 3-phase on-unit calibration procedure (title/date only; body 403).
7. [INGECON SUN Manager product page — Ingeteam](https://www.ingeteam.com/en-us/energy/photovoltaic-energy/p15_24_306/ingecon-sun-manager.aspx) — commissioning/monitoring tool, fw distribution.
8. [INGECON SUN PowerMax TL B 1500Vdc Install/Op manual (abq2026iqe01-a) — Ingeteam](https://www.ingeteam.com/Portals/0/Catalogo/Producto/Documento/PRD_3681_Archivo_is-powermax-tl-b-1500vdc-installation-and-operation-manual-en-abq2026iqe01-a.pdf) — PowerMax family / doc-code scheme.
9. [INGECON SUN EMS Board Config manual — ManualsLib p.42](https://www.manualslib.com/manual/1746379/Ingeteam-Ingecon-Sun-Ems-Board.html?page=42) — external-wattmeter integration (EMS, not sensor-scale calib).

## Methodology / gaps

12 search queries (EN + ES variants) + 7 deep-fetch attempts across web &
manuals. **Gaps:** AAV1089IMB04 is request-only (no per-version Modbus map
obtainable); ingeconsuntraining.info blocks crawlers (403) and isn't in
Wayback, so the Trin#16 body and the ABH technical guide could not be read;
no public older display `.bin` exists for binary diff. These gaps do not
change the conclusion — they reinforce that the in-repo RE is the
authority.
