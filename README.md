# Cosmic Clock

Three real-time, 3D-zoomable diagrams:

1. **Earth (Lawrence, KS)** — rotating globe + day/night lighting driven by the real Sun direction.
2. **Solar System (inner)** — Earth’s live heliocentric position (AU) around the Sun.
3. **Milky Way (stylized)** — Solar System plotted in a simplified galaxy view (includes a *time exaggeration* slider so motion is visible).

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
  - Milky Way time exaggeration

## Notes / accuracy
- Earth rotation is approximated as a sidereal rotation for a nice “clock feel”.
- Sun direction + local Sun altitude/azimuth use `astronomy-engine`.
- “Solar System position in the Milky Way” is **not clock-like at human timescales** (galactic orbital period is ~230 million years), so the Galaxy panel includes an exaggeration slider.

## Credits
- Earth texture from Three.js examples: https://threejs.org/examples/
- Astronomy calculations via `astronomy-engine`: https://github.com/cosinekitty/astronomy
