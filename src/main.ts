import './style.css'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import GUI from 'lil-gui'
import {
  Body,
  GeoVector,
  HelioVector,
  Observer,
  Equator,
  Horizon,
  EquatorFromVector,
  SiderealTime,
} from 'astronomy-engine'

// Lawrence, KS
const DEFAULT_LAT = 38.9717
const DEFAULT_LON = -95.2353

type Panel = {
  name: string
  root: HTMLElement
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  onResize: () => void
  onFrame: (t: AstroClockTime) => void
}

type AstroClockTime = {
  now: Date
  // simulation time (can be sped up)
  sim: Date
  // seconds elapsed in real time since last frame
  dtReal: number
}

class TimeController {
  private lastRealMs = performance.now()
  public paused = false
  public speed = 1 // 1 = real-time
  public simTime = new Date()

  resetNow() {
    this.simTime = new Date()
  }

  tick(): AstroClockTime {
    const realNowMs = performance.now()
    const dtReal = (realNowMs - this.lastRealMs) / 1000
    this.lastRealMs = realNowMs

    const now = new Date()

    if (!this.paused) {
      const dtSimMs = dtReal * 1000 * this.speed
      this.simTime = new Date(this.simTime.getTime() + dtSimMs)
    }

    return { now, sim: new Date(this.simTime), dtReal }
  }
}

function makePanel(name: string, root: HTMLElement): Panel {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color('#05060a')

  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1e9)
  camera.position.set(0, 1.4, 3.2)

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  root.appendChild(renderer.domElement)

  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.05

  const onResize = () => {
    const w = root.clientWidth
    const h = root.clientHeight
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }

  return {
    name,
    root,
    renderer,
    scene,
    camera,
    controls,
    onResize,
    onFrame: () => {},
  }
}

function textOverlay(el: HTMLElement, lines: string[]) {
  el.innerHTML = lines.map((s) => `<div>${s}</div>`).join('')
}

function formatTime(d: Date) {
  const pad = (n: number) => `${n}`.padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function unit(v: THREE.Vector3) {
  const out = v.clone()
  if (out.lengthSq() > 0) out.normalize()
  return out
}

function astroToThreeVec(v: { x: number; y: number; z: number }, scale = 1) {
  // astronomy-engine vectors are in an equatorial coordinate system where +Z is north.
  // Three.js is typically Y-up, so map astro Z -> three Y.
  // We also map astro Y -> three Z to keep a right-handed system.
  return new THREE.Vector3(v.x * scale, v.z * scale, v.y * scale)
}

async function buildEarthPanel(
  panel: Panel,
  opts: {
    getLat: () => number
    getLon: () => number
    getLabel?: () => string
    getTextureOffsetDeg?: () => number
  }
) {
  const { scene, camera, controls } = panel

  // Lights
  // Keep ambient low so the night side is actually dark.
  const ambient = new THREE.AmbientLight(0x112233, 0.12)
  scene.add(ambient)

  const sunLight = new THREE.DirectionalLight(0xffffff, 1.8)
  sunLight.position.set(5, 0, 0)
  scene.add(sunLight)

  // Earth (higher-res day texture)
  const dayUrl = `${import.meta.env.BASE_URL}textures/earth_day_4k.jpg`
  const dayTex = await new THREE.TextureLoader().loadAsync(dayUrl)
  dayTex.colorSpace = THREE.SRGBColorSpace
  dayTex.anisotropy = 8

  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(1, 96, 96),
    new THREE.MeshStandardMaterial({ map: dayTex, roughness: 1, metalness: 0 })
  )
  scene.add(earth)

  // Simple atmosphere rim
  const atmo = new THREE.Mesh(
    new THREE.SphereGeometry(1.03, 64, 64),
    new THREE.MeshBasicMaterial({ color: 0x2a7fff, transparent: true, opacity: 0.08 })
  )
  scene.add(atmo)

  // Location marker (attach to Earth so it rotates correctly)
  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(0.02, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xffcc33 })
  )
  earth.add(marker)

  controls.target.set(0, 0, 0)
  controls.minDistance = 1.4
  controls.maxDistance = 10

  const overlay = panel.root.querySelector<HTMLElement>('.overlay')!

  // Orientation knobs
  const obliquityDeg = 23.43928
  const obliquity = (obliquityDeg * Math.PI) / 180
  // Texture prime meridian offset (depends on the texture). We'll expose this via GUI.
  const textureOffsetDeg = 0

  panel.onFrame = (t) => {
    // Sun direction (from Earth to Sun) for lighting.
    // GeoVector() gives an Earth-centered vector toward the Sun.
    const gv = GeoVector(Body.Sun, t.sim, true)
    const sunDir = unit(astroToThreeVec(gv, 1))
    sunLight.position.copy(sunDir.multiplyScalar(5))

    // Earth axial tilt (constant, for the "seasons" feel).
    // Apply as a rotation around Z so you see the terminator tilt over the year.
    earth.rotation.set(0, 0, 0)
    atmo.rotation.set(0, 0, 0)
    earth.rotateZ(obliquity)
    atmo.rotateZ(obliquity)

    // Rotate Earth around its tilted axis so the subsolar longitude is approximately correct.
    // Compute subsolar longitude from Greenwich sidereal time and Sun RA.
    // RA/GST are in hours.
    const eqGeo = EquatorFromVector(gv)
    const raHours = eqGeo.ra
    const gstHours = SiderealTime(t.sim)
    const haDeg = ((gstHours - raHours) * 15 + 540) % 360 - 180 // (-180,180]
    const subsolarLonDeg = -haDeg

    const texOff = opts.getTextureOffsetDeg ? opts.getTextureOffsetDeg() : textureOffsetDeg
    const spin = ((subsolarLonDeg + texOff) * Math.PI) / 180
    earth.rotateY(spin)
    atmo.rotateY(spin)

    // Place marker at lat/lon (Lawrence, KS by default)
    const lat = opts.getLat()
    const lon = opts.getLon()

    const latRad = (lat * Math.PI) / 180
    const lonRad = (lon * Math.PI) / 180
    const r = 1.01
    marker.position.set(
      r * Math.cos(latRad) * Math.cos(lonRad),
      r * Math.sin(latRad),
      r * Math.cos(latRad) * Math.sin(lonRad)
    )

    // Local sun altitude/azimuth
    const observer = new Observer(lat, lon, 0)
    const eqTop = Equator(Body.Sun, t.sim, observer, true, true)
    const hor = Horizon(t.sim, observer, eqTop.ra, eqTop.dec, 'normal')

    const label = opts.getLabel ? opts.getLabel() : 'Earth'

    textOverlay(overlay, [
      `<b>${label}</b>`,
      `Local time: ${formatTime(t.now)}`,
      `Sim time: ${formatTime(t.sim)}`,
      `Subsolar lon (approx): ${subsolarLonDeg.toFixed(1)}°`,
      `Sun alt/az: ${hor.altitude.toFixed(1)}° / ${hor.azimuth.toFixed(1)}°`,
    ])
  }

  // framing
  camera.position.set(0, 1.2, 3.0)
}

function buildSolarPanel(panel: Panel) {
  const { scene, camera, controls } = panel

  const ambient = new THREE.AmbientLight(0x223344, 0.25)
  scene.add(ambient)

  const sunLight = new THREE.PointLight(0xffffff, 3.2, 0)
  sunLight.position.set(0, 0, 0)
  scene.add(sunLight)

  // Scene scale: 1 unit = 1 AU
  const AU = 1

  // Sun
  const sun = new THREE.Mesh(
    new THREE.SphereGeometry(0.12, 32, 32),
    new THREE.MeshBasicMaterial({ color: 0xffcc66 })
  )
  scene.add(sun)

  // Bodies we will render
  const bodies: Array<{
    body: Body
    name: string
    color: number
    radius: number
    aAU: number // approximate semi-major axis, for orbit rings
  }> = [
    { body: Body.Mercury, name: 'Mercury', color: 0xb0b0b0, radius: 0.018, aAU: 0.387 },
    { body: Body.Venus, name: 'Venus', color: 0xe7c27c, radius: 0.026, aAU: 0.723 },
    { body: Body.Earth, name: 'Earth', color: 0x5aa9ff, radius: 0.028, aAU: 1.0 },
    { body: Body.Mars, name: 'Mars', color: 0xff7760, radius: 0.022, aAU: 1.524 },
    { body: Body.Jupiter, name: 'Jupiter', color: 0xd9b38c, radius: 0.055, aAU: 5.203 },
    { body: Body.Saturn, name: 'Saturn', color: 0xe8d39a, radius: 0.050, aAU: 9.537 },
    { body: Body.Uranus, name: 'Uranus', color: 0x9ad8e8, radius: 0.040, aAU: 19.191 },
    { body: Body.Neptune, name: 'Neptune', color: 0x6f89ff, radius: 0.040, aAU: 30.07 },
  ]

  // Orbit rings (flat ecliptic plane for readability)
  for (const b of bodies) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(b.aAU * AU - 0.01, b.aAU * AU + 0.01, 192),
      new THREE.MeshBasicMaterial({ color: 0x29405f, side: THREE.DoubleSide, transparent: true, opacity: 0.28 })
    )
    ring.rotation.x = Math.PI / 2
    scene.add(ring)
  }

  // Planet meshes
  const planetMeshes = new Map<Body, THREE.Mesh>()
  for (const b of bodies) {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(b.radius, 24, 24),
      new THREE.MeshStandardMaterial({ color: b.color, roughness: 0.95, metalness: 0 })
    )
    scene.add(mesh)
    planetMeshes.set(b.body, mesh)
  }

  // Moon (shown near Earth, with exaggerated distance)
  const moon = new THREE.Mesh(
    new THREE.SphereGeometry(0.010, 20, 20),
    new THREE.MeshStandardMaterial({ color: 0xd6d6d6, roughness: 1, metalness: 0 })
  )
  scene.add(moon)

  const overlay = panel.root.querySelector<HTMLElement>('.overlay')!

  // Helpers
  const axes = new THREE.AxesHelper(0.6)
  ;(axes.material as THREE.Material).transparent = true
  ;(axes.material as THREE.Material).opacity = 0.18
  scene.add(axes)

  controls.target.set(0, 0, 0)
  controls.minDistance = 0.8
  controls.maxDistance = 80

  panel.onFrame = (t) => {
    // Place planets (flatten to XZ plane for legibility)
    for (const b of bodies) {
      const hv = HelioVector(b.body, t.sim) // AU
      const p = astroToThreeVec(hv, AU)
      const mesh = planetMeshes.get(b.body)!
      mesh.position.set(p.x, 0, p.y)
    }

    const earthMesh = planetMeshes.get(Body.Earth)!

    // Moon position: geocentric vector from Earth to Moon.
    // We exaggerate the distance so it's visible at AU scale.
    const moonVec = GeoVector(Body.Moon, t.sim, true) // AU from Earth center
    const moonP = astroToThreeVec(moonVec, AU)
    const moonExaggeration = 60
    moon.position.copy(earthMesh.position.clone().add(new THREE.Vector3(moonP.x, 0, moonP.y).multiplyScalar(moonExaggeration)))

    // Overlay
    const earthR = earthMesh.position.length()
    const theta = Math.atan2(earthMesh.position.z, earthMesh.position.x)
    const deg = (theta * 180) / Math.PI

    textOverlay(overlay, [
      `<b>Solar System (planets + Moon)</b>`,
      `Sim time: ${formatTime(t.sim)}`,
      `Earth–Sun distance: ${earthR.toFixed(3)} AU`,
      `Earth orbit angle (approx): ${deg.toFixed(1)}°`,
      `Moon distance exaggerated: ×${moonExaggeration}`,
    ])
  }

  camera.position.set(0, 10, 12)
  camera.lookAt(0, 0, 0)
}

function buildGalaxyPanel(panel: Panel, params: { getExaggeration: () => number }) {
  const { scene, camera, controls } = panel

  const ambient = new THREE.AmbientLight(0x223344, 0.4)
  scene.add(ambient)

  // Stylized Milky Way disk
  const disk = new THREE.Mesh(
    new THREE.CircleGeometry(5, 128),
    new THREE.MeshBasicMaterial({ color: 0x0b1020, transparent: true, opacity: 0.9 })
  )
  disk.rotation.x = -Math.PI / 2
  scene.add(disk)

  // Spiral-ish ring bands
  for (let i = 1; i <= 4; i++) {
    const r0 = i * 1.0
    const band = new THREE.Mesh(
      new THREE.RingGeometry(r0 - 0.05, r0 + 0.05, 128),
      new THREE.MeshBasicMaterial({ color: 0x1a2a44, side: THREE.DoubleSide, transparent: true, opacity: 0.35 })
    )
    band.rotation.x = Math.PI / 2
    scene.add(band)
  }

  // Galactic center
  const center = new THREE.Mesh(
    new THREE.SphereGeometry(0.12, 24, 24),
    new THREE.MeshBasicMaterial({ color: 0xff8866 })
  )
  scene.add(center)

  // Sun marker
  const sun = new THREE.Mesh(
    new THREE.SphereGeometry(0.06, 24, 24),
    new THREE.MeshBasicMaterial({ color: 0xffdd88 })
  )
  scene.add(sun)

  // Orbit path
  const orbit = new THREE.Mesh(
    new THREE.RingGeometry(3.0 - 0.01, 3.0 + 0.01, 256),
    new THREE.MeshBasicMaterial({ color: 0x335577, side: THREE.DoubleSide, transparent: true, opacity: 0.6 })
  )
  orbit.rotation.x = Math.PI / 2
  scene.add(orbit)

  controls.target.set(0, 0, 0)
  controls.minDistance = 1.5
  controls.maxDistance = 40

  const overlay = panel.root.querySelector<HTMLElement>('.overlay')!

  // Constants (rough): Sun ~ 8.2 kpc from center.
  // We draw that as radius 3.0 in scene units.
  const R_DRAW = 3.0

  panel.onFrame = (t) => {
    // Galactic orbital period ~ 230 million years.
    const P_years = 230_000_000
    const P_ms = P_years * 365.25 * 24 * 3600 * 1000

    const epoch = Date.UTC(2000, 0, 1, 12, 0, 0)
    const msSinceEpoch = t.sim.getTime() - epoch

    // Exaggeration lets it move visibly.
    const exaggeration = params.getExaggeration()
    const effective = msSinceEpoch * exaggeration

    const angle = (effective / P_ms) * Math.PI * 2

    sun.position.set(R_DRAW * Math.cos(angle), 0, R_DRAW * Math.sin(angle))

    textOverlay(overlay, [
      `<b>Milky Way (stylized)</b>`,
      `Sim time: ${formatTime(t.sim)}`,
      `Model: Sun at ~8.2 kpc; orbit ~230 Myr`,
      `Time exaggeration: ×${exaggeration.toLocaleString()}`,
    ])
  }

  camera.position.set(0, 7, 7)
  camera.lookAt(0, 0, 0)
}

function makePanelShell(parent: HTMLElement, title: string) {
  const shell = document.createElement('section')
  shell.className = 'panel'
  shell.innerHTML = `
    <div class="panelTitle">${title}</div>
    <div class="overlay"></div>
  `
  parent.appendChild(shell)
  return shell
}

async function main() {
  const app = document.querySelector<HTMLDivElement>('#app')!
  app.innerHTML = `
    <header>
      <div class="brand">Cosmic Clock</div>
      <div class="hint">Drag to orbit • Scroll to zoom • Right-drag to pan</div>
    </header>
    <div id="panels"></div>
  `

  const panelsRoot = document.querySelector<HTMLDivElement>('#panels')!

  const earthShell = makePanelShell(panelsRoot, 'Earth')
  const solarShell = makePanelShell(panelsRoot, 'Solar System')
  const galaxyShell = makePanelShell(panelsRoot, 'Milky Way')

  const time = new TimeController()

  const params = {
    paused: false,
    speed: 1,
    resetNow: () => time.resetNow(),
    lat: DEFAULT_LAT,
    lon: DEFAULT_LON,
    galaxyExaggeration: 5_000_000, // default so you can see it move
    earthTextureOffsetDeg: 0,
  }

  const gui = new GUI({ title: 'Cosmic Clock' })
  gui.add(params, 'paused').onChange((v: boolean) => (time.paused = v))
  gui.add(params, 'speed', { '1× (real time)': 1, '60× (1 min/sec)': 60, '3600× (1 hr/sec)': 3600, '86400× (1 day/sec)': 86400 }).onChange((v: number) => (time.speed = v))
  gui.add(params, 'resetNow')

  const earthFolder = gui.addFolder('Earth')
  earthFolder.add(params, 'earthTextureOffsetDeg', -180, 180, 0.1).name('texture offset (deg)')
  earthFolder.close()

  const locFolder = gui.addFolder('Location')
  locFolder.add(params, 'lat', -90, 90, 0.0001)
  locFolder.add(params, 'lon', -180, 180, 0.0001)
  locFolder.close()

  const galFolder = gui.addFolder('Galaxy')
  galFolder.add(params, 'galaxyExaggeration', 1, 200_000_000, 1).name('time exaggeration')
  galFolder.close()

  time.paused = params.paused
  time.speed = params.speed

  const panels: Panel[] = [
    makePanel('earth', earthShell),
    makePanel('solar', solarShell),
    makePanel('galaxy', galaxyShell),
  ]

  await buildEarthPanel(panels[0], {
    getLat: () => params.lat,
    getLon: () => params.lon,
    getLabel: () => `Earth (Lawrence, KS)`,
    getTextureOffsetDeg: () => params.earthTextureOffsetDeg,
  } as any)
  buildSolarPanel(panels[1])
  buildGalaxyPanel(panels[2], {
    getExaggeration: () => params.galaxyExaggeration,
  })

  const ro = new ResizeObserver(() => panels.forEach((p) => p.onResize()))
  panels.forEach((p) => ro.observe(p.root))
  panels.forEach((p) => p.onResize())

  function frame() {
    const t = time.tick()

    for (const p of panels) {
      p.controls.update()
      p.onFrame(t)
      p.renderer.render(p.scene, p.camera)
    }
    requestAnimationFrame(frame)
  }

  requestAnimationFrame(frame)
}

main().catch((err) => {
  console.error(err)
  const app = document.querySelector<HTMLDivElement>('#app')!
  app.textContent = String(err)
})
