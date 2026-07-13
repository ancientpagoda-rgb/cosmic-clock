# Cosmic Clock

Three real-time, 3D-zoomable diagrams:

1. **Earth (Lawrence, KS)** — rotating globe + day/night lighting driven by the real Sun direction.
2. **Solar System** — live heliocentric planet positions in AU, plus an exaggerated Moon marker near Earth.
3. **Universe** — conceptual cosmic-web view with a cosmic-age slider and approximate flat ΛCDM scale factor/redshift readout.

## Live demo (GitHub Pages)
After you push this repo to GitHub and enable Pages (Actions), it will deploy automatically.

Expected URL:
- `https://<your-user>.github.io/cosmic-clock/`

## Run locally

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
npm run preview
```

## Controls
- Drag to orbit
- Scroll to zoom
- Right-drag to pan
- Use the GUI (top-right) for:
  - pause / resume
  - time speed
  - reset to “now”
  - location (lat/lon)
  - Earth texture offset
  - Universe age

## Notes / accuracy
- Earth rotation uses Greenwich sidereal time. Texture alignment is a separate visual offset so it does not change the physical Sun direction.
- Sun direction + local Sun altitude/azimuth use `astronomy-engine`.
- Solar System positions use `astronomy-engine` heliocentric vectors. Orbit rings are circular reference guides, not exact elliptical or inclined orbits.
- The Moon is positioned from its geocentric vector, but its distance is exaggerated so it remains visible at AU scale.
- The Universe panel uses a Planck-like flat matter+lambda approximation for `a(t)` and redshift. The point cloud, filaments, brightness, and rotation are illustrative, not a cosmological simulation.
- Clock and sim timestamps are shown in the browser time zone; local solar altitude/daylight is computed from the configured latitude/longitude.

## Credits
- Earth texture from Three.js examples: https://threejs.org/examples/
- Astronomy calculations via `astronomy-engine`: https://github.com/cosinekitty/astronomy
