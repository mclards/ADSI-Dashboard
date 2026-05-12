## Slice κ: Critical Alarm Pattern Auto-Block & IGBT/AC Contactor Health Hardening

### Critical Alarm Pattern Auto-Block
- Auto-STOP on recurring critical patterns: 0x0240 (IGBT), 0x0040 (AC Contactor), 0x0210 (Faults) detected ≥2 times per 48 hours
- Manual write block after auto-STOP with operator confirmation flow
- Per-unit state tracking with soft/hard thresholds
- Graceful per-slave STOP + counter reset on acknowledge

### IGBT & AC Contactor Health
- IGBT Health monitoring with end-of-life detection
- AC Contactor health snapshot and historical trending
- Health status export and API endpoints for external integration

### False-Positive Hardening (6 gates)
- Temperature cross-validation before escalation
- Phantom alarm suppression on communication gaps
- Solar-window validity checking for weather-dependent alarms
- Filter parameter consistency verification
- DC voltage stability checks for transient alarms
- Inverter communication quality gating

### Engineering Improvements
- 55 new regression tests for alarm pattern logic
- Counter recovery integration with alarm workflows
- Improved audit logging for alarm lifecycle

**Python service rebuild required for this release.**
