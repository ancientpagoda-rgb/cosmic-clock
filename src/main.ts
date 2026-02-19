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

  // Texture prime meridian offset (depends on the texture). We'll expose this via GUI.
  // (0 means: texture seam/origin as-is.)
  const textureOffsetDeg = 0

  panel.onFrame = (t) => {
    // Sun direction (from Earth to Sun) for lighting.
    // GeoVector() gives an Earth-centered *equatorial* vector toward the Sun.
    const gv = GeoVector(Body.Sun, t.sim, true)
    const sunDir = unit(astroToThreeVec(gv, 1))
    sunLight.position.copy(sunDir.multiplyScalar(5))

    // Earth orientation: rotate Earth-fixed longitudes into the same equatorial frame as the Sun vector.
    // Use Greenwich sidereal time to spin the Earth around its north axis.
    const gstHours = SiderealTime(t.sim)
    const gstRad = (gstHours * 15 * Math.PI) / 180

    const texOff = opts.getTextureOffsetDeg ? opts.getTextureOffsetDeg() : textureOffsetDeg
    const offRad = (texOff * Math.PI) / 180

    earth.rotation.set(0, 0, 0)
    atmo.rotation.set(0, 0, 0)

    // Sign: negative so increasing sidereal time rotates Earth eastward under the inertial sky.
    earth.rotation.y = -gstRad + offRad
    atmo.rotation.y = -gstRad + offRad

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

    const daylight = hor.altitude > 0

    textOverlay(overlay, [
      `<b>${label}</b>`,
      `Local time: ${formatTime(t.now)}`,
      `Sim time: ${formatTime(t.sim)}`,
      `Sun alt/az: ${hor.altitude.toFixed(1)}° / ${hor.azimuth.toFixed(1)}°`,
      `Lawrence: ${daylight ? 'daylight' : 'night'}`,
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

  // Trails: short fading path behind each planet
  type Trail = {
    positions: Float32Array
    geom: THREE.BufferGeometry
    line: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>
    index: number
    count: number
  }

  const TRAIL_POINTS = 512
  const trails = new Map<Body, Trail>()

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

  // Trail lines
  for (const b of bodies) {
    const positions = new Float32Array(TRAIL_POINTS * 3)
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geom.setDrawRange(0, 0)

    const mat = new THREE.LineBasicMaterial({
      color: 0x90a4ae,
      transparent: true,
      opacity: 0.35,
    })

    const line = new THREE.Line(geom, mat)
    scene.add(line)

    trails.set(b.body, {
      positions,
      geom,
      line,
      index: 0,
      count: 0,
    })
  }

  function pushTrail(body: Body, pos: THREE.Vector3) {
    const trail = trails.get(body)
    if (!trail) return
    const { positions, geom } = trail

    const i = trail.index
    positions[3 * i + 0] = pos.x
    positions[3 * i + 1] = pos.y
    positions[3 * i + 2] = pos.z

    trail.index = (i + 1) % TRAIL_POINTS
    trail.count = Math.min(TRAIL_POINTS, trail.count + 1)

    geom.setDrawRange(0, trail.count)
    geom.attributes.position.needsUpdate = true
  }

  // Moon (shown near Earth, with exaggerated distance)
  const moon = new THREE.Mesh(
    new THREE.SphereGeometry(0.010, 20, 20),
    new THREE.MeshStandardMaterial({ color: 0xd6d6d6, roughness: 1, metalness: 0 })
  )
  scene.add(moon)

  const overlay = panel.root.querySelector<HTMLElement>('.overlay')!
  const tooltip = panel.root.querySelector<HTMLElement>('.tooltip')!

  // Hover labels
  const raycaster = new THREE.Raycaster()
  const mouse = new THREE.Vector2()
  const hoverTargets: Array<{ obj: THREE.Object3D; label: string }> = []

  for (const b of bodies) {
    hoverTargets.push({ obj: planetMeshes.get(b.body)!, label: b.name })
  }
  hoverTargets.push({ obj: moon, label: 'Moon' })

  function onPointerMove(ev: PointerEvent) {
    const rect = panel.renderer.domElement.getBoundingClientRect()
    const x = ((ev.clientX - rect.left) / rect.width) * 2 - 1
    const y = -(((ev.clientY - rect.top) / rect.height) * 2 - 1)
    mouse.set(x, y)

    raycaster.setFromCamera(mouse, panel.camera)

    const intersects = raycaster.intersectObjects(hoverTargets.map((t) => t.obj), true)
    if (intersects.length === 0) {
      tooltip.style.display = 'none'
      return
    }

    const hit = intersects[0].object
    const found = hoverTargets.find((t) => t.obj === hit || t.obj.children.includes(hit))
    tooltip.textContent = found?.label ?? 'Object'
    tooltip.style.display = 'block'
    tooltip.style.left = `${ev.clientX - rect.left + 12}px`
    tooltip.style.top = `${ev.clientY - rect.top + 12}px`
  }

  panel.renderer.domElement.addEventListener('pointermove', onPointerMove)
  panel.renderer.domElement.addEventListener('pointerleave', () => {
    tooltip.style.display = 'none'
  })

  // Helpers
  const axes = new THREE.AxesHelper(0.6)
  ;(axes.material as THREE.Material).transparent = true
  ;(axes.material as THREE.Material).opacity = 0.18
  scene.add(axes)

  controls.target.set(0, 0, 0)
  controls.minDistance = 0.8
  controls.maxDistance = 80

  panel.onFrame = (t) => {
    // Place planets (flatten to XZ plane for legibility) + record trails
    for (const b of bodies) {
      const hv = HelioVector(b.body, t.sim) // AU
      const p = astroToThreeVec(hv, AU)
      const mesh = planetMeshes.get(b.body)!
      mesh.position.set(p.x, 0, p.y)

      pushTrail(b.body, mesh.position)
    }

    const earthMesh = planetMeshes.get(Body.Earth)!

    // Moon position: geocentric vector from Earth to Moon.
    // We exaggerate the distance so it's visible at AU scale.
    const moonVec = GeoVector(Body.Moon, t.sim, true) // AU from Earth center
    const moonP = astroToThreeVec(moonVec, AU)
    const moonExaggeration = 60
    moon.position.copy(
      earthMesh.position
        .clone()
        .add(new THREE.Vector3(moonP.x, 0, moonP.y).multiplyScalar(moonExaggeration))
    )

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

function buildUniversePanel(panel: Panel) {
  const { scene, camera, controls } = panel

  scene.background = new THREE.Color('#020309')

  const starsMaterial = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 0.02,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.8,
  })

  const galaxyGeom = new THREE.BufferGeometry()
  const GALAXY_POINTS = 2000
  const positions = new Float32Array(GALAXY_POINTS * 3)

  // Simple fake “cosmic web”: points in a clumpy disc
  for (let i = 0; i < GALAXY_POINTS; i++) {
    const r = Math.pow(Math.random(), 0.6) * 8 // dense center, sparser outskirts
    const angle = Math.random() * Math.PI * 2
    const height = (Math.random() - 0.5) * 1.5

    positions[3 * i + 0] = r * Math.cos(angle)
    positions[3 * i + 1] = height
    positions[3 * i + 2] = r * Math.sin(angle)
  }
  galaxyGeom.setAttribute('position', new THREE.BufferAttribute(positions, 3))

  const galaxy = new THREE.Points(galaxyGeom, starsMaterial)
  scene.add(galaxy)

  const overlay = panel.root.querySelector<HTMLElement>('.overlay')!

  controls.target.set(0, 0, 0)
  controls.minDistance = 4
  controls.maxDistance = 40
  camera.position.set(0, 12, 16)
  camera.lookAt(0, 0, 0)

  panel.onFrame = (t) => {
    // Map sim time to a pseudo “scale factor” 0.2–1.0 over a 200-year window
    const baseYear = 2000
    const simYear = t.sim.getUTCFullYear()
    const deltaYears = simYear - baseYear
    const a = Math.min(1, Math.max(0.2, 0.2 + (deltaYears / 200) * 0.8))

    const scale = a
    galaxy.scale.set(scale, scale, scale)

    // Slow rotation
    const rot = (t.sim.getTime() / (1000 * 60 * 60 * 24 * 30)) % (2 * Math.PI)
    galaxy.rotation.y = rot

    const epochLabel =
      deltaYears < -100
        ? 'early universe (conceptual)'
        : deltaYears > 100
        ? 'late universe (conceptual)'
        : 'near “today”'

    textOverlay(overlay, [
      '<b>Universe (conceptual)</b>',
      `Sim time: ${formatTime(t.sim)} UTC`,
      `Pseudo scale factor a(t): ${a.toFixed(3)}`,
      `Epoch: ${epochLabel}`,
      'Note: visualization is artistic, not physically exact.',
    ])
  }
}

function makePanelShell(parent: HTMLElement, title: string) {
  const shell = document.createElement('section')
  shell.className = 'panel'
  shell.innerHTML = `
    <div class="panelTitle">${title}</div>
    <div class="overlay"></div>
    <div class="tooltip" style="display:none"></div>
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
  const universeShell = makePanelShell(panelsRoot, 'Universe')

  const time = new TimeController()

  const params = {
    paused: false,
    speed: 1,
    resetNow: () => time.resetNow(),
    lat: DEFAULT_LAT,
    lon: DEFAULT_LON,
    earthTextureOffsetDeg: 0,
  }

  const gui = new GUI({ title: 'Cosmic Clock' })
  gui.add(params, 'paused').onChange((v: boolean) => (time.paused = v))
  gui
    .add(params, 'speed', {
      '1× (real time)': 1,
      '60× (1 min/sec)': 60,
      '3600× (1 hr/sec)': 3600,
      '86400× (1 day/sec)': 86400,
    })
    .onChange((v: number) => (time.speed = v))
  gui.add(params, 'resetNow')

  const earthFolder = gui.addFolder('Earth')
  earthFolder
    .add(params, 'earthTextureOffsetDeg', -180, 180, 0.1)
    .name('texture offset (deg)')
  earthFolder.close()

  const locFolder = gui.addFolder('Location')
  locFolder.add(params, 'lat', -90, 90, 0.0001)
  locFolder.add(params, 'lon', -180, 180, 0.0001)
  locFolder.close()

  time.paused = params.paused
  time.speed = params.speed

  const panels: Panel[] = [
    makePanel('earth', earthShell),
    makePanel('solar', solarShell),
    makePanel('universe', universeShell),
  ]

  await buildEarthPanel(panels[0], {
    getLat: () => params.lat,
    getLon: () => params.lon,
    getLabel: () => `Earth (Lawrence, KS)`,
    getTextureOffsetDeg: () => params.earthTextureOffsetDeg,
  } as any)
  buildSolarPanel(panels[1])
  buildUniversePanel(panels[2])

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
