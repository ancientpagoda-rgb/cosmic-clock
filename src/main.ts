import './style.css'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import GUI from 'lil-gui'
import { Body, GeoVector, HelioVector, Observer, Equator, Horizon } from 'astronomy-engine'

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
  // astronomy-engine uses a right-handed coordinate system; we'll map x,y,z directly.
  return new THREE.Vector3(v.x * scale, v.y * scale, v.z * scale)
}

async function buildEarthPanel(
  panel: Panel,
  opts: { getLat: () => number; getLon: () => number; getLabel?: () => string }
) {
  const { scene, camera, controls } = panel

  // Lights
  const ambient = new THREE.AmbientLight(0x223344, 0.35)
  scene.add(ambient)

  const sunLight = new THREE.DirectionalLight(0xffffff, 1.4)
  sunLight.position.set(5, 0, 0)
  scene.add(sunLight)

  // Earth
  const texUrl = `${import.meta.env.BASE_URL}textures/earth_atmos_2048.jpg`
  const tex = await new THREE.TextureLoader().loadAsync(texUrl)
  tex.colorSpace = THREE.SRGBColorSpace

  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(1, 64, 64),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 1, metalness: 0 })
  )
  scene.add(earth)

  // Simple atmosphere rim
  const atmo = new THREE.Mesh(
    new THREE.SphereGeometry(1.03, 64, 64),
    new THREE.MeshBasicMaterial({ color: 0x2a7fff, transparent: true, opacity: 0.08 })
  )
  scene.add(atmo)

  // Location marker
  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(0.02, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xffcc33 })
  )
  scene.add(marker)

  controls.target.set(0, 0, 0)
  controls.minDistance = 1.4
  controls.maxDistance = 10

  const overlay = panel.root.querySelector<HTMLElement>('.overlay')!

  panel.onFrame = (t) => {
    // Rotate Earth according to simulation time (approx; "clock-like")
    // 360 degrees per sidereal day ~ 86164.0905s
    const siderealSec = 86164.0905
    const epoch = Date.UTC(2000, 0, 1, 12, 0, 0)
    const secSinceEpoch = (t.sim.getTime() - epoch) / 1000
    const rot = (secSinceEpoch / siderealSec) * Math.PI * 2
    earth.rotation.y = rot
    atmo.rotation.y = rot

    // Sun direction (from Earth to Sun) for lighting
    const gv = GeoVector(Body.Sun, t.sim, true)
    const sunDir = unit(astroToThreeVec(gv, 1))
    sunLight.position.copy(sunDir.multiplyScalar(5))

    // Place marker at lat/lon
    const lat = opts.getLat()
    const lon = opts.getLon()

    const latRad = (lat * Math.PI) / 180
    const lonRad = (lon * Math.PI) / 180
    const r = 1.01
    // lon: east-positive. Convert: x = r*cos(lat)*cos(lon), z = r*cos(lat)*sin(lon)
    marker.position.set(
      r * Math.cos(latRad) * Math.cos(lonRad),
      r * Math.sin(latRad),
      r * Math.cos(latRad) * Math.sin(lonRad)
    )

    // Rough local sun altitude for Lawrence KS
    const observer = new Observer(lat, lon, 0)
    const eq = Equator(Body.Sun, t.sim, observer, true, true)
    const hor = Horizon(t.sim, observer, eq.ra, eq.dec, 'normal')

    const label = opts.getLabel ? opts.getLabel() : 'Earth'

    textOverlay(overlay, [
      `<b>${label}</b>`,
      `Local time: ${formatTime(t.now)}`,
      `Sim time: ${formatTime(t.sim)}`,
      `Sun altitude: ${hor.altitude.toFixed(1)}°`,
      `Sun azimuth: ${hor.azimuth.toFixed(1)}°`,
    ])
  }

  // framing
  camera.position.set(0, 1.2, 3.0)
}

function buildSolarPanel(panel: Panel) {
  const { scene, camera, controls } = panel

  const ambient = new THREE.AmbientLight(0x223344, 0.35)
  scene.add(ambient)

  const sunLight = new THREE.PointLight(0xffffff, 3, 0)
  sunLight.position.set(0, 0, 0)
  scene.add(sunLight)

  // Sun
  const sun = new THREE.Mesh(
    new THREE.SphereGeometry(0.15, 32, 32),
    new THREE.MeshBasicMaterial({ color: 0xffcc66 })
  )
  scene.add(sun)

  // Earth orbit ring (approx circle)
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.98, 1.02, 128),
    new THREE.MeshBasicMaterial({ color: 0x335577, side: THREE.DoubleSide, transparent: true, opacity: 0.6 })
  )
  ring.rotation.x = Math.PI / 2
  scene.add(ring)

  // Earth
  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(0.05, 24, 24),
    new THREE.MeshStandardMaterial({ color: 0x5aa9ff, roughness: 0.9, metalness: 0 })
  )
  scene.add(earth)

  // Tiny axis helper
  const axes = new THREE.AxesHelper(0.5)
  ;(axes.material as THREE.Material).transparent = true
  ;(axes.material as THREE.Material).opacity = 0.25
  scene.add(axes)

  controls.target.set(0, 0, 0)
  controls.minDistance = 0.6
  controls.maxDistance = 20

  const overlay = panel.root.querySelector<HTMLElement>('.overlay')!

  panel.onFrame = (t) => {
    // Heliocentric Earth vector in AU
    const hv = HelioVector(Body.Earth, t.sim)
    const p = astroToThreeVec(hv, 1) // AU units

    // Put ecliptic plane in XZ for readability
    earth.position.set(p.x, 0, p.y) // using y as "z" (flatten)

    const r = Math.sqrt(earth.position.x ** 2 + earth.position.z ** 2)

    // Season marker: ecliptic longitude of Sun as seen from Earth
    // (Simple indicator from the helio vector angle)
    const theta = Math.atan2(earth.position.z, earth.position.x) // radians
    const deg = (theta * 180) / Math.PI

    textOverlay(overlay, [
      `<b>Solar System (inner)</b>`,
      `Sim time: ${formatTime(t.sim)}`,
      `Earth–Sun distance: ${r.toFixed(3)} AU`,
      `Orbit angle (approx): ${deg.toFixed(1)}°`,
    ])
  }

  camera.position.set(0, 2.2, 3.5)
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
  }

  const gui = new GUI({ title: 'Cosmic Clock' })
  gui.add(params, 'paused').onChange((v: boolean) => (time.paused = v))
  gui.add(params, 'speed', { '1× (real time)': 1, '60× (1 min/sec)': 60, '3600× (1 hr/sec)': 3600, '86400× (1 day/sec)': 86400 }).onChange((v: number) => (time.speed = v))
  gui.add(params, 'resetNow')

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
    getLabel: () => `Earth (Lawrence, KS)`
  })
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
