# Persistent Floating Camera Attempt

This was the initial attempt to make the Hikvision camera card persist as a Picture-in-Picture floating window by detaching its DOM element and appending it to document.body.

## Why it was reverted
When the #hikvisionCard was detached from the grid, its bounding rectangle briefly disappeared. The Native Hardware Overlay (LocalService), which tracks this exact rectangle to know where to draw its hardware-accelerated video on Windows, received a 0x0 coordinate update and crashed with \Error: LocalService command failed (16)\.

This proved that the Native Overlay is strictly bound to its DOM lifecycle and cannot be arbitrarily detached from the active grid container without crashing the backend player.

## Proposed Alternative
The 'Hybrid Hikvision Camera Mode' was proposed as a safe alternative (see \hybrid-hikvision-camera-mode.md\).
