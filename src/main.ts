import './style.css'
import './lil-gui-overrides.css'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import GUI from 'lil-gui'
import {
  Body,
  Ecliptic,
  GeoVector,
  HelioVector,
  Observer,
  Equator,
  Horizon,
  SiderealTime,
  Vector as AstroVector,
} from 'astronomy-engine'

// Lawrence, KS
const DEFAULT_LAT = 38.9717
const DEFAULT_LON = -95.2353
const OBLIQUITY_RAD = (23.439292 * Math.PI) / 180
const DEFAULT_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'browser time'

const LCDM = {
  omegaMatter: 0.315,
  omegaLambda: 0.685,
  // Planck-like H0 ~= 67.4 km/s/Mpc converted to inverse gigayears.
  hubblePerGyr: 1 / (9.778 / 0.674),
}

const AU_KM = 149597870.7

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
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.12
  root.appendChild(renderer.domElement)

  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.065
  controls.rotateSpeed = 0.28
  controls.zoomSpeed = 0.7
  controls.panSpeed = 0.28
  controls.enablePan = true
  controls.screenSpacePanning = false
  controls.minPolarAngle = 0.08
  controls.maxPolarAngle = Math.PI - 0.08

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

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function formatTime(d: Date) {
  const pad = (n: number) => `${n}`.padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function formatLocationLabel(lat: number, lon: number) {
  const isDefault =
    Math.abs(lat - DEFAULT_LAT) < 0.0001 && Math.abs(lon - DEFAULT_LON) < 0.0001
  return isDefault ? 'Earth (Lawrence, KS)' : `Earth (${lat.toFixed(4)}, ${lon.toFixed(4)})`
}

function unit(v: THREE.Vector3) {
  const out = v.clone()
  if (out.lengthSq() > 0) out.normalize()
  return out
}

function astroToThreeVec(v: AstroVector, scale = 1) {
  // astronomy-engine vectors are in an equatorial coordinate system where +Z is north.
  // Three.js is typically Y-up, so map astro Z -> three Y.
  // We also map astro Y -> three Z to keep a right-handed system.
  return new THREE.Vector3(v.x * scale, v.z * scale, v.y * scale)
}

function eclipticToThreeVec(v: AstroVector, scale = 1) {
  // astronomy-engine ecliptic vectors use +Z as ecliptic north.
  // Three.js stays Y-up here, so map ecliptic Z -> three Y.
  return new THREE.Vector3(v.x * scale, v.z * scale, v.y * scale)
}

function helioToEclipticPlane(v: AstroVector, scale = 1) {
  // astronomy-engine already gives heliocentric vectors in the J2000 equatorial
  // frame. Convert that to the true ecliptic of date, then flatten to a top-down view.
  const eclip = Ecliptic(v).vec
  return new THREE.Vector3(eclip.x * scale, 0, eclip.y * scale)
}

function helioToEclipticVec(v: AstroVector, scale = 1) {
  // Use the actual 3D heliocentric vector, rotated into the true ecliptic frame.
  return eclipticToThreeVec(Ecliptic(v).vec, scale)
}

function vectorLength(v: AstroVector, scale = 1) {
  return Math.hypot(v.x, v.y, v.z) * scale
}

function lcdmScaleFactor(ageGyr: number) {
  const { omegaMatter, omegaLambda, hubblePerGyr } = LCDM
  const lambdaMatterRatio = Math.sqrt(omegaLambda / omegaMatter)
  const sinhTerm = Math.sinh(1.5 * hubblePerGyr * Math.sqrt(omegaLambda) * ageGyr)
  return Math.max(1e-6, Math.pow(sinhTerm / lambdaMatterRatio, 2 / 3))
}

type GalaxySample = {
  name: string
  distanceMpc: number
  velocityKms: number
}

function hashString(value: string) {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function makeGlowTexture(
  innerColor: string,
  outerColor: string,
  size = 256
) {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Glow texture context unavailable')

  const cx = size / 2
  const cy = size / 2
  const radius = size / 2
  const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius)
  gradient.addColorStop(0, innerColor)
  gradient.addColorStop(0.28, innerColor)
  gradient.addColorStop(0.72, outerColor)
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, size, size)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

function makeGlowSprite(
  innerColor: string,
  outerColor: string,
  opacity: number,
  size = 256
) {
  const texture = makeGlowTexture(innerColor, outerColor, size)
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    opacity,
    color: 0xffffff,
  })
  const sprite = new THREE.Sprite(material)
  sprite.renderOrder = -1
  return sprite
}

async function loadGalaxySamples() {
  const url = `${import.meta.env.BASE_URL}data/galaxies.csv`
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) {
    throw new Error(`Failed to load galaxy catalog: ${res.status}`)
  }

  const text = await res.text()
  const lines = text.trim().split(/\r?\n/)
  lines.shift()

  const samples: GalaxySample[] = []
  for (const line of lines) {
    const [name, mod0Raw, vgsrRaw] = line.split(',')
    const mod0 = Number(mod0Raw)
    const velocityKms = Number(vgsrRaw)
    if (!name || !Number.isFinite(mod0) || !Number.isFinite(velocityKms)) continue

    // Distance modulus -> parsec, then to megaparsec.
    const distanceMpc = Math.pow(10, (mod0 - 25) / 5)
    if (!Number.isFinite(distanceMpc)) continue
    if (distanceMpc > 250 || Math.abs(velocityKms) > 15000) continue

    samples.push({ name, distanceMpc, velocityKms })
  }

  samples.sort((a, b) => a.distanceMpc - b.distanceMpc)
  return samples
}

function drawMoonInset(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  moonVec: AstroVector
) {
  const w = canvas.width
  const h = canvas.height
  ctx.clearRect(0, 0, w, h)

  const bg = ctx.createLinearGradient(0, 0, w, h)
  bg.addColorStop(0, 'rgba(7, 12, 24, 0.95)')
  bg.addColorStop(1, 'rgba(3, 5, 11, 0.96)')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, w, h)

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)'
  ctx.lineWidth = 1
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1)

  const earthRadiusPx = 2.8
  const moonRadiusPx = earthRadiusPx * (1737.4 / 6371)
  const earthRadii = vectorLength(moonVec, AU_KM) / 6371
  const distancePx = earthRadii * earthRadiusPx

  const earthX = 58
  const centerY = h * 0.56
  const moonX = earthX + distancePx

  // Scale ticks
  ctx.strokeStyle = 'rgba(120, 150, 190, 0.22)'
  ctx.beginPath()
  for (let i = 0; i <= 6; i++) {
    const x = earthX + i * 28
    ctx.moveTo(x, centerY - 14)
    ctx.lineTo(x, centerY + 14)
  }
  ctx.stroke()

  // Earth -> Moon line
  ctx.strokeStyle = 'rgba(153, 201, 255, 0.38)'
  ctx.lineWidth = 1.4
  ctx.beginPath()
  ctx.moveTo(earthX + earthRadiusPx, centerY)
  ctx.lineTo(moonX - moonRadiusPx, centerY)
  ctx.stroke()

  // Earth
  const earthGlow = ctx.createRadialGradient(
    earthX - 1,
    centerY - 1,
    1,
    earthX,
    centerY,
    earthRadiusPx * 3.5
  )
  earthGlow.addColorStop(0, 'rgba(120, 190, 255, 0.9)')
  earthGlow.addColorStop(1, 'rgba(40, 90, 160, 0.05)')
  ctx.fillStyle = earthGlow
  ctx.beginPath()
  ctx.arc(earthX, centerY, earthRadiusPx * 3.2, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = 'rgba(115, 186, 255, 0.96)'
  ctx.beginPath()
  ctx.arc(earthX, centerY, earthRadiusPx, 0, Math.PI * 2)
  ctx.fill()

  // Moon
  ctx.fillStyle = 'rgba(222, 222, 228, 0.96)'
  ctx.beginPath()
  ctx.arc(moonX, centerY, moonRadiusPx, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = 'rgba(255, 255, 255, 0.92)'
  ctx.font = '12px "Avenir Next", "Trebuchet MS", sans-serif'
  ctx.fillText('Moon inset, true scale', 12, 18)
  ctx.fillStyle = 'rgba(223, 231, 255, 0.78)'
  ctx.font = '11px "Avenir Next", "Trebuchet MS", sans-serif'
  ctx.fillText(`1 Earth radius = ${earthRadiusPx.toFixed(1)} px`, 12, 35)
  ctx.fillText(`Moon distance = ${earthRadii.toFixed(1)} Earth radii`, 12, h - 14)

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.11)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(earthX, centerY + 18)
  ctx.lineTo(earthX + earthRadiusPx * 10, centerY + 18)
  ctx.stroke()
  ctx.fillText('10 Earth radii', earthX, centerY + 34)
}

type HubbleFit = {
  slope: number
  intercept: number
  sampleCount: number
  minDistanceMpc: number
}

function fitHubbleSample(samples: GalaxySample[], minDistanceMpc = 5): HubbleFit {
  const subset = samples.filter((sample) => sample.distanceMpc > minDistanceMpc)
  if (subset.length === 0) {
    return { slope: 67.4, intercept: 0, sampleCount: 0, minDistanceMpc }
  }

  let sumX = 0
  let sumY = 0
  for (const sample of subset) {
    sumX += sample.distanceMpc
    sumY += sample.velocityKms
  }

  const meanX = sumX / subset.length
  const meanY = sumY / subset.length

  let sxx = 0
  let sxy = 0
  for (const sample of subset) {
    const dx = sample.distanceMpc - meanX
    sxx += dx * dx
    sxy += dx * (sample.velocityKms - meanY)
  }

  const slope = sxx > 0 ? sxy / sxx : 67.4
  const intercept = meanY - slope * meanX
  return { slope, intercept, sampleCount: subset.length, minDistanceMpc }
}

function buildHubbleChartSvg(samples: GalaxySample[], fit: HubbleFit) {
  if (samples.length === 0) {
    return '<div class="chart-empty">No galaxy sample loaded.</div>'
  }

  const width = 300
  const height = 92
  const padL = 28
  const padR = 10
  const padT = 8
  const padB = 18

  const subsetCount = Math.min(samples.length, 150)
  const step = Math.max(1, Math.floor(samples.length / subsetCount))
  const subset = samples.filter((_, i) => i % step === 0).slice(0, subsetCount)

  const xMax = Math.max(20, ...subset.map((s) => s.distanceMpc))
  const yMax = Math.max(
    1500,
    ...subset.map((s) => Math.abs(s.velocityKms)),
    Math.abs(fit.intercept),
    Math.abs(fit.slope * xMax + fit.intercept)
  )

  const sx = (d: number) => padL + (d / xMax) * (width - padL - padR)
  const sy = (v: number) => height - padB - ((v + yMax) / (2 * yMax)) * (height - padT - padB)
  const fitY1 = sy(fit.intercept)
  const fitY2 = sy(fit.slope * xMax + fit.intercept)

  const points = subset
    .map((s) => {
      const x = sx(s.distanceMpc)
      const y = sy(s.velocityKms)
      const density = clamp(s.distanceMpc / xMax, 0, 1)
      const r = 1.3 + density * 0.9
      const alpha = 0.28 + density * 0.58
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="rgb(170 231 255)" fill-opacity="${alpha.toFixed(3)}" />`
    })
    .join('')

  const gridLines = [0, 0.25, 0.5, 0.75, 1]
    .map((t) => {
      const x = padL + t * (width - padL - padR)
      const y = padT + t * (height - padT - padB)
      return `
        <line x1="${x.toFixed(1)}" y1="${padT}" x2="${x.toFixed(1)}" y2="${height - padB}" stroke="rgba(255,255,255,0.06)" />
        <line x1="${padL}" y1="${y.toFixed(1)}" x2="${width - padR}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,0.06)" />
      `
    })
    .join('')

  const axis = `
    <line x1="${padL}" y1="${height - padB}" x2="${width - padR}" y2="${height - padB}" stroke="rgba(255,255,255,0.24)" />
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${height - padB}" stroke="rgba(255,255,255,0.24)" />
  `

  const line = `
    <line x1="${padL}" y1="${fitY1.toFixed(1)}" x2="${width - padR}" y2="${fitY2.toFixed(1)}" stroke="rgb(255 204 102)" stroke-opacity="0.9" stroke-width="2" />
  `

  return `
    <svg class="hubble-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Galaxy distance versus recession velocity chart">
      <defs>
        <linearGradient id="hubbleGlow" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="rgb(86 184 255)" stop-opacity="0.18" />
          <stop offset="100%" stop-color="rgb(255 204 102)" stop-opacity="0.05" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="${width}" height="${height}" rx="14" fill="url(#hubbleGlow)" />
      ${gridLines}
      ${axis}
      ${line}
      ${points}
      <text x="12" y="18" fill="rgba(255,255,255,0.88)" font-size="11" font-family="Avenir Next, Trebuchet MS, sans-serif">Hubble sample</text>
      <text x="${width - 10}" y="${height - 4}" text-anchor="end" fill="rgba(255,255,255,0.58)" font-size="9" font-family="Avenir Next, Trebuchet MS, sans-serif">distance (Mpc)</text>
      <text x="12" y="${height - 4}" fill="rgba(255,255,255,0.58)" font-size="9" font-family="Avenir Next, Trebuchet MS, sans-serif">velocity (km/s)</text>
    </svg>
  `
}

export async function buildEarthPanel(
  panel: Panel,
  opts: {
    getLat: () => number
    getLon: () => number
    getLabel?: () => string
    getTextureOffsetDeg?: () => number
    getWeatherLines?: () => string[]
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
  dayTex.wrapS = THREE.RepeatWrapping

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
  // Default to 180° to better align day/night with the current texture.
  const textureOffsetDeg = 180

  panel.onFrame = (t) => {
    // GeoVector(Sun) is the geocentric Earth->Sun vector. Keep this direction
    // so the lit hemisphere agrees with Astronomy Engine's local altitude.
    const gv = GeoVector(Body.Sun, t.sim, true)
    const sunDir = unit(astroToThreeVec(gv, 1))
    sunLight.position.copy(sunDir.multiplyScalar(5))

    // Earth orientation: rotate Earth-fixed longitudes into the same equatorial frame as the Sun vector.
    // Use Greenwich sidereal time to spin the Earth around its north axis.
    const gstHours = SiderealTime(t.sim)
    const gstRad = (gstHours * 15 * Math.PI) / 180

    const texOff = opts.getTextureOffsetDeg ? opts.getTextureOffsetDeg() : textureOffsetDeg
    dayTex.offset.x = texOff / 360

    earth.rotation.set(0, 0, 0)
    atmo.rotation.set(0, 0, 0)

    // Sign: negative so increasing sidereal time rotates Earth eastward under the inertial sky.
    earth.rotation.y = -gstRad
    atmo.rotation.y = -gstRad

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

    const weatherLines = opts.getWeatherLines ? opts.getWeatherLines() : []

    textOverlay(overlay, [
      `<b>${label}</b>`,
      `Clock time: ${formatTime(t.now)} (${DEFAULT_TIME_ZONE})`,
      `Sim time: ${formatTime(t.sim)} (${DEFAULT_TIME_ZONE})`,
      `Sun alt/az: ${hor.altitude.toFixed(1)}° / ${hor.azimuth.toFixed(1)}°`,
      `Location: ${daylight ? 'daylight' : 'night'}`,
      ...weatherLines,
    ])
  }

  // framing
  camera.position.set(0, 1.2, 3.0)
}

export function buildSolarPanel(panel: Panel) {
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
    { body: Body.Mercury, name: 'Mercury', color: 0xb0b0b0, radius: 0.035, aAU: 0.387 },
    { body: Body.Venus,   name: 'Venus',   color: 0xe7c27c, radius: 0.050, aAU: 0.723 },
    { body: Body.Earth,   name: 'Earth',   color: 0x5aa9ff, radius: 0.055, aAU: 1.0 },
    { body: Body.Mars,    name: 'Mars',    color: 0xff7760, radius: 0.040, aAU: 1.524 },
    { body: Body.Jupiter, name: 'Jupiter', color: 0xd9b38c, radius: 0.090, aAU: 5.203 },
    { body: Body.Saturn,  name: 'Saturn',  color: 0xe8d39a, radius: 0.080, aAU: 9.537 },
    { body: Body.Uranus,  name: 'Uranus',  color: 0x9ad8e8, radius: 0.070, aAU: 19.191 },
    { body: Body.Neptune, name: 'Neptune', color: 0x6f89ff, radius: 0.070, aAU: 30.07 },
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
    new THREE.SphereGeometry(0.015, 20, 20),
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
  controls.minDistance = 0.6
  controls.maxDistance = 40

  panel.onFrame = (t) => {
    // Place planets (flatten to XZ plane for legibility) + record trails
    let earthDistanceAU = 0
    for (const b of bodies) {
      const hv = HelioVector(b.body, t.sim) // AU
      const p = helioToEclipticPlane(hv, AU)
      const mesh = planetMeshes.get(b.body)!
      mesh.position.copy(p)
      if (b.body === Body.Earth) earthDistanceAU = vectorLength(hv, AU)

      pushTrail(b.body, mesh.position)
    }

    const earthMesh = planetMeshes.get(Body.Earth)!

    // Moon position: geocentric vector from Earth to Moon.
    // We exaggerate the distance so it's visible at AU scale.
    const moonVec = GeoVector(Body.Moon, t.sim, true) // AU from Earth center
    const moonP = helioToEclipticPlane(moonVec, AU)
    const moonExaggeration = 60
    moon.position.copy(
      earthMesh.position
        .clone()
        .add(moonP.multiplyScalar(moonExaggeration))
    )

    // Overlay
    const theta = Math.atan2(earthMesh.position.z, earthMesh.position.x)
    const deg = (theta * 180) / Math.PI

    textOverlay(overlay, [
      `<b>Solar System (planets + Moon)</b>`,
      `Sim time: ${formatTime(t.sim)}`,
      `Earth–Sun distance: ${earthDistanceAU.toFixed(3)} AU`,
      `Earth orbit angle (approx): ${deg.toFixed(1)}°`,
      `Moon distance exaggerated: ×${moonExaggeration}`,
    ])
  }

  camera.position.set(0, 7, 9)
  camera.lookAt(0, 0, 0)
}

export function buildUniversePanel(panel: Panel, getCosmicAgeGyr: () => number) {
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

  // Simple fake 3D “cosmic web”: clumpy sphere with filaments
  for (let i = 0; i < GALAXY_POINTS; i++) {
    // radius biased toward shell, not center
    const u = Math.random()
    const r = Math.pow(u, 0.4) * 8

    // random direction on a sphere
    const theta = Math.acos(2 * Math.random() - 1)
    const phi = Math.random() * 2 * Math.PI

    let x = r * Math.sin(theta) * Math.cos(phi)
    let y = r * Math.cos(theta)
    let z = r * Math.sin(theta) * Math.sin(phi)

    // Occasional “filament” stretching along one axis
    if (Math.random() < 0.2) {
      const stretch = 1 + Math.random() * 2
      const axis = Math.floor(Math.random() * 3)
      if (axis === 0) x *= stretch
      else if (axis === 1) y *= stretch
      else z *= stretch
    }

    positions[3 * i + 0] = x
    positions[3 * i + 1] = y
    positions[3 * i + 2] = z
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

  panel.onFrame = () => {
    // Cosmic age slider defines age in Gyr. Scale factor/redshift use the
    // analytic flat matter+lambda relation, while the point cloud is illustrative.
    const ageGyr = getCosmicAgeGyr()
    const a = lcdmScaleFactor(ageGyr)
    const z = 1 / a - 1

    // Use a compressed display scale so future expansion does not fly out of frame.
    const displayA = Math.log1p(a) / Math.log1p(lcdmScaleFactor(13.8))
    const scale = 0.35 + Math.min(displayA, 2.4) * 0.65
    galaxy.scale.set(scale, scale, scale)

    // Fade structures in over time
    const opacity = 0.15 + 0.65 * Math.min(1, a / lcdmScaleFactor(13.8))
    starsMaterial.opacity = opacity

    // Slow rotation in comoving coordinates
    const rot = performance.now() / 10000
    galaxy.rotation.y = rot

    // Very rough epoch labeling by redshift / age
    let epochLabel = 'late universe'
    if (ageGyr < 0.18) epochLabel = 'dark ages / cosmic dawn'
    else if (ageGyr < 1) epochLabel = 'first galaxies / reionization'
    else if (ageGyr < 6) epochLabel = 'peak star formation era'
    else if (ageGyr < 10) epochLabel = 'maturing cosmic web'
    else if (ageGyr < 13.8) epochLabel = 'late galaxy evolution'
    else if (ageGyr < 20) epochLabel = 'dark energy era'
    else epochLabel = 'far future (Λ-dominated)'

    textOverlay(overlay, [
      '<b>Universe (conceptual, ΛCDM-ish)</b>',
      `Cosmic age ≈ ${ageGyr.toFixed(2)} Gyr`,
      `Scale factor a(t) ≈ ${a.toFixed(3)}`,
      `Redshift z ≈ ${z.toFixed(2)}`,
      `Epoch: ${epochLabel}`,
      'Note: structure + evolution are illustrative, not a full simulation.',
    ])
  }
}

async function buildCombinedPanel(
  panel: Panel,
  opts: {
    getLat: () => number
    getLon: () => number
    getLabel?: () => string
    getTextureOffsetDeg?: () => number
    getCosmicAgeGyr: () => number
    galaxySamples: GalaxySample[]
    getWeatherLines?: () => string[]
  }
) {
  const { scene, camera, controls } = panel

  scene.background = new THREE.Color('#020309')

  const ambient = new THREE.AmbientLight(0x223344, 0.22)
  scene.add(ambient)

  const sunLight = new THREE.PointLight(0xffffff, 3.8, 0)
  sunLight.position.set(0, 0, 0)
  scene.add(sunLight)

  const sunGlow = makeGlowSprite(
    'rgba(255, 230, 180, 0.92)',
    'rgba(255, 204, 102, 0.12)',
    0.92
  )
  sunGlow.scale.setScalar(0.92)
  scene.add(sunGlow)

  let motionMix = 1
  let targetMotionMix = 1

  const backdropGroup = new THREE.Group()
  backdropGroup.position.set(-12, 0, -12)
  backdropGroup.rotation.y = -0.28
  scene.add(backdropGroup)

  // Universe backdrop: HyperLeda galaxy sample plotted as an observed Hubble flow.
  const galaxySamples = opts.galaxySamples
  const galaxyGeom = new THREE.BufferGeometry()
  const positions = new Float32Array(galaxySamples.length * 3)
  const colors = new Float32Array(galaxySamples.length * 3)

  const distScale = 0.11
  const velScale = 0.00008
  const depthScale = 0.45

  for (let i = 0; i < galaxySamples.length; i++) {
    const sample = galaxySamples[i]
    const x = sample.distanceMpc * distScale
    const y = sample.velocityKms * velScale
    const jitter = ((hashString(sample.name) % 1000) / 999 - 0.5) * depthScale

    positions[3 * i + 0] = x
    positions[3 * i + 1] = y
    positions[3 * i + 2] = jitter

    const density = clamp(sample.distanceMpc / 250, 0, 1)
    const color = new THREE.Color()
    color.setHSL(0.58 - density * 0.48, 0.72, 0.55 + (1 - density) * 0.12)
    colors[3 * i + 0] = color.r
    colors[3 * i + 1] = color.g
    colors[3 * i + 2] = color.b

  }

  galaxyGeom.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  galaxyGeom.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  const galaxyMaterial = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 0.03,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.82,
    vertexColors: true,
  })
  const galaxy = new THREE.Points(galaxyGeom, galaxyMaterial)
  backdropGroup.add(galaxy)

  const galaxyGrid = new THREE.GridHelper(40, 16, 0x1f3557, 0x102033)
  galaxyGrid.rotation.x = Math.PI / 2
  galaxyGrid.position.y = 0
  ;(galaxyGrid.material as THREE.Material).transparent = true
  ;(galaxyGrid.material as THREE.Material).opacity = 0.15
  backdropGroup.add(galaxyGrid)

  // Solar system scale: 1 unit = 1 AU.
  const AU = 1
  const displayScale = 0.22
  const earthRadius = 0.13
  const bodies: Array<{
    body: Body
    name: string
    color: number
    radius: number
    aAU: number
  }> = [
    { body: Body.Mercury, name: 'Mercury', color: 0xb0b0b0, radius: 0.035, aAU: 0.387 },
    { body: Body.Venus, name: 'Venus', color: 0xe7c27c, radius: 0.05, aAU: 0.723 },
    { body: Body.Earth, name: 'Earth', color: 0x5aa9ff, radius: earthRadius, aAU: 1.0 },
    { body: Body.Mars, name: 'Mars', color: 0xff7760, radius: 0.04, aAU: 1.524 },
    { body: Body.Jupiter, name: 'Jupiter', color: 0xd9b38c, radius: 0.09, aAU: 5.203 },
    { body: Body.Saturn, name: 'Saturn', color: 0xe8d39a, radius: 0.08, aAU: 9.537 },
    { body: Body.Uranus, name: 'Uranus', color: 0x9ad8e8, radius: 0.07, aAU: 19.191 },
    { body: Body.Neptune, name: 'Neptune', color: 0x6f89ff, radius: 0.07, aAU: 30.07 },
  ]

  type Trail = {
    positions: Float32Array
    geom: THREE.BufferGeometry
    line: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>
    index: number
    count: number
  }

  const TRAIL_POINTS = 512
  const trails = new Map<Body, Trail>()
  const planetGroups = new Map<Body, THREE.Group>()
  const planetMeshes = new Map<Body, THREE.Mesh>()
  const hoverTargets: Array<{ obj: THREE.Object3D; label: string }> = []

  for (const b of bodies) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(b.aAU * AU * displayScale - 0.006, b.aAU * AU * displayScale + 0.006, 192),
      new THREE.MeshBasicMaterial({
        color: 0x29405f,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.28,
      })
    )
    ring.rotation.x = Math.PI / 2
    scene.add(ring)
  }

  const earthTex = await new THREE.TextureLoader().loadAsync(
    `${import.meta.env.BASE_URL}textures/earth_day_4k.jpg`
  )
  earthTex.colorSpace = THREE.SRGBColorSpace
  earthTex.anisotropy = 8
  earthTex.wrapS = THREE.RepeatWrapping

  for (const b of bodies) {
    const group = new THREE.Group()
    if (b.body === Body.Earth) {
      group.rotation.x = -OBLIQUITY_RAD
    }
    scene.add(group)
    planetGroups.set(b.body, group)

    let mesh: THREE.Mesh
    if (b.body === Body.Earth) {
      mesh = new THREE.Mesh(
        new THREE.SphereGeometry(b.radius, 96, 96),
        new THREE.MeshStandardMaterial({ map: earthTex, roughness: 1, metalness: 0 })
      )

      const atmosphere = new THREE.Mesh(
        new THREE.SphereGeometry(b.radius * 1.03, 64, 64),
        new THREE.MeshBasicMaterial({ color: 0x2a7fff, transparent: true, opacity: 0.1 })
      )
      group.add(atmosphere)

      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.02, 16, 16),
        new THREE.MeshBasicMaterial({ color: 0xffcc33 })
      )
      marker.name = 'earth-marker'
      mesh.add(marker)
    } else {
      mesh = new THREE.Mesh(
        new THREE.SphereGeometry(b.radius, 24, 24),
        new THREE.MeshStandardMaterial({ color: b.color, roughness: 0.95, metalness: 0 })
      )
    }

    group.add(mesh)
    planetMeshes.set(b.body, mesh)
    hoverTargets.push({ obj: mesh, label: b.name })

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
    trails.set(b.body, { positions, geom, line, index: 0, count: 0 })
  }

  // Moon shown near Earth, with exaggerated distance so it stays legible at AU scale.
  const moon = new THREE.Mesh(
    new THREE.SphereGeometry(0.015, 20, 20),
    new THREE.MeshStandardMaterial({ color: 0xd6d6d6, roughness: 1, metalness: 0 })
  )
  scene.add(moon)
  hoverTargets.push({ obj: moon, label: 'Moon' })

  const overlay = panel.root.querySelector<HTMLElement>('.overlay')!
  const tooltip = panel.root.querySelector<HTMLElement>('.tooltip')!

  const moonInset = document.createElement('div')
  moonInset.className = 'moon-inset'
  moonInset.innerHTML = `
    <div class="moon-inset-title">Moon true scale</div>
    <canvas class="moon-inset-canvas" width="460" height="140"></canvas>
    <div class="moon-inset-note">Earth-Moon distance rendered at actual scale, using the current geocentric vector.</div>
  `
  panel.root.appendChild(moonInset)
  const moonInsetCanvas = moonInset.querySelector<HTMLCanvasElement>('.moon-inset-canvas')!
  const moonInsetCtx = moonInsetCanvas.getContext('2d')
  if (!moonInsetCtx) {
    throw new Error('Moon inset canvas unavailable')
  }

  const hubbleStrip = document.createElement('div')
  hubbleStrip.className = 'hubble-strip'
  hubbleStrip.innerHTML = `
    <div class="hubble-strip-title">Hubble flow / HyperLeda sample</div>
    <div class="hubble-strip-chart"></div>
    <div class="hubble-strip-note">Distance modulus to distance, velocity versus distance, least-squares fit with intercept.</div>
  `
  panel.root.appendChild(hubbleStrip)
  const hubbleStripChart = hubbleStrip.querySelector<HTMLDivElement>('.hubble-strip-chart')!
  const hubbleFit = fitHubbleSample(galaxySamples)
  const h0Fit = hubbleFit.slope
  const ageFromH0 = 977.8 / h0Fit
  hubbleStripChart.innerHTML = buildHubbleChartSvg(galaxySamples, hubbleFit)

  overlay.innerHTML = `
    <div class="combined-overlay">
      <section class="info-card info-card-earth">
        <p class="card-kicker">Earth</p>
        <h2 data-field="earth-label"></h2>
        <div class="card-lines">
          <div>Clock time: <span data-field="clock-time"></span></div>
          <div>Sim time: <span data-field="sim-time"></span></div>
          <div>Sun alt/az: <span data-field="sun-altaz"></span></div>
          <div>Location: <span data-field="daylight"></span></div>
          <div>Earth axial tilt: <span data-field="earth-tilt"></span> · Moon inset: true scale, Earth radius = 2.8 px</div>
          <div data-field="weather-line"></div>
        </div>
      </section>
      <section class="info-card info-card-solar">
        <p class="card-kicker">Solar System</p>
        <h2>Planets in motion</h2>
        <div class="card-lines">
          <div>Earth-Sun distance: <span data-field="earth-distance"></span> AU</div>
          <div>Earth ecliptic longitude: <span data-field="earth-longitude"></span></div>
          <div>Moon main-view scale: <span data-field="moon-exaggeration"></span>x for legibility</div>
          <div>Moon true distance: <span data-field="moon-distance"></span> km (<span data-field="moon-earth-radii"></span> Earth radii)</div>
        </div>
      </section>
      <section class="info-card info-card-universe">
        <p class="card-kicker">Universe</p>
        <h2>ΛCDM age model</h2>
        <div class="card-lines">
          <div>Cosmic age ≈ <span data-field="cosmic-age"></span> Gyr</div>
          <div>Scale factor a(t) ≈ <span data-field="scale-factor"></span></div>
          <div>Redshift z ≈ <span data-field="redshift"></span></div>
          <div>Backdrop: HyperLeda galaxy sample (<span data-field="galaxy-count"></span> objects)</div>
          <div>H0 fit ≈ <span data-field="h0-fit"></span> km/s/Mpc, offset ≈ <span data-field="hubble-offset"></span> km/s, Hubble time ≈ <span data-field="hubble-time"></span> Gyr</div>
          <div>Epoch: <span data-field="epoch"></span></div>
        </div>
      </section>
    </div>
  `
  const overlayFields = {
    earthLabel: overlay.querySelector<HTMLElement>('[data-field="earth-label"]')!,
    clockTime: overlay.querySelector<HTMLElement>('[data-field="clock-time"]')!,
    simTime: overlay.querySelector<HTMLElement>('[data-field="sim-time"]')!,
    sunAltAz: overlay.querySelector<HTMLElement>('[data-field="sun-altaz"]')!,
    daylight: overlay.querySelector<HTMLElement>('[data-field="daylight"]')!,
    earthTilt: overlay.querySelector<HTMLElement>('[data-field="earth-tilt"]')!,
    weatherLine: overlay.querySelector<HTMLElement>('[data-field="weather-line"]')!,
    earthDistance: overlay.querySelector<HTMLElement>('[data-field="earth-distance"]')!,
    earthLongitude: overlay.querySelector<HTMLElement>('[data-field="earth-longitude"]')!,
    moonExaggeration: overlay.querySelector<HTMLElement>('[data-field="moon-exaggeration"]')!,
    moonDistance: overlay.querySelector<HTMLElement>('[data-field="moon-distance"]')!,
    moonEarthRadii: overlay.querySelector<HTMLElement>('[data-field="moon-earth-radii"]')!,
    cosmicAge: overlay.querySelector<HTMLElement>('[data-field="cosmic-age"]')!,
    scaleFactor: overlay.querySelector<HTMLElement>('[data-field="scale-factor"]')!,
    redshift: overlay.querySelector<HTMLElement>('[data-field="redshift"]')!,
    galaxyCount: overlay.querySelector<HTMLElement>('[data-field="galaxy-count"]')!,
    h0Fit: overlay.querySelector<HTMLElement>('[data-field="h0-fit"]')!,
    hubbleOffset: overlay.querySelector<HTMLElement>('[data-field="hubble-offset"]')!,
    hubbleTime: overlay.querySelector<HTMLElement>('[data-field="hubble-time"]')!,
    epoch: overlay.querySelector<HTMLElement>('[data-field="epoch"]')!,
  }

  const raycaster = new THREE.Raycaster()
  const mouse = new THREE.Vector2()

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

  controls.target.set(0, 0, 0)
  controls.minDistance = 2
  controls.maxDistance = 80
  camera.position.set(0, 12, 18)
  camera.lookAt(0, 0, 0)
  controls.addEventListener('start', () => {
    targetMotionMix = 0.22
  })
  controls.addEventListener('end', () => {
    targetMotionMix = 1
  })

  panel.onFrame = (t) => {
    const ageGyr = opts.getCosmicAgeGyr()
    const a = lcdmScaleFactor(ageGyr)
    const z = 1 / a - 1
    const timeSec = performance.now() / 1000
    motionMix += (targetMotionMix - motionMix) * 0.08
    const ambientMotion = 0.18 + motionMix * 0.82

    galaxy.scale.set(0.82, 0.82, 0.82)
    galaxy.rotation.y = 0.22 + Math.sin(timeSec * 0.03) * 0.018 * ambientMotion
    galaxy.rotation.z = Math.sin(timeSec * 0.017) * 0.012 * ambientMotion
    galaxyMaterial.opacity = 0.74 + Math.sin(timeSec * 0.11) * 0.04 * ambientMotion
    backdropGroup.rotation.y = -0.28 + Math.sin(timeSec * 0.01) * 0.03 * ambientMotion
    backdropGroup.rotation.z = Math.sin(timeSec * 0.02) * 0.02 * ambientMotion
    sunGlow.scale.setScalar(0.92 + Math.sin(timeSec * 1.9) * 0.035 * ambientMotion)

    let epochLabel = 'late universe'
    if (ageGyr < 0.18) epochLabel = 'dark ages / cosmic dawn'
    else if (ageGyr < 1) epochLabel = 'first galaxies / reionization'
    else if (ageGyr < 6) epochLabel = 'peak star formation era'
    else if (ageGyr < 10) epochLabel = 'maturing cosmic web'
    else if (ageGyr < 13.8) epochLabel = 'late galaxy evolution'
    else if (ageGyr < 20) epochLabel = 'dark energy era'
    else epochLabel = 'far future (Λ-dominated)'

    let earthDistanceAU = 0
    for (const b of bodies) {
      const hv = HelioVector(b.body, t.sim)
      const p = helioToEclipticVec(hv, AU * displayScale)
      const group = planetGroups.get(b.body)!
      group.position.copy(p)
      if (b.body === Body.Earth) earthDistanceAU = vectorLength(hv, AU)
      pushTrail(b.body, group.position)
    }

    const earthGroup = planetGroups.get(Body.Earth)!
    const earthMesh = planetMeshes.get(Body.Earth)!

    const moonVec = GeoVector(Body.Moon, t.sim, true)
    const moonP = helioToEclipticVec(moonVec, AU * displayScale)
    const moonExaggeration = 60
    moon.position.copy(earthGroup.position.clone().add(moonP.multiplyScalar(moonExaggeration)))

    const textureOffsetDeg = opts.getTextureOffsetDeg ? opts.getTextureOffsetDeg() : 180
    earthTex.offset.x = textureOffsetDeg / 360

    const gstHours = SiderealTime(t.sim)
    const gstRad = (gstHours * 15 * Math.PI) / 180
    earthGroup.rotation.y = -gstRad

    const lat = opts.getLat()
    const lon = opts.getLon()
    const latRad = (lat * Math.PI) / 180
    const lonRad = (lon * Math.PI) / 180
    const markerMesh = earthMesh.children.find((child) => child.name === 'earth-marker') as THREE.Mesh
    markerMesh.position.set(
      1.01 * earthRadius * Math.cos(latRad) * Math.cos(lonRad),
      1.01 * earthRadius * Math.sin(latRad),
      1.01 * earthRadius * Math.cos(latRad) * Math.sin(lonRad)
    )

    const observer = new Observer(lat, lon, 0)
    const eqTop = Equator(Body.Sun, t.sim, observer, true, true)
    const hor = Horizon(t.sim, observer, eqTop.ra, eqTop.dec, 'normal')

    const label = opts.getLabel ? opts.getLabel() : 'Earth'
    const daylight = hor.altitude > 0
    const weatherLines = opts.getWeatherLines ? opts.getWeatherLines() : []

    const moonDistanceKm = vectorLength(moonVec, AU_KM)
    const moonDistanceEarthRadii = moonDistanceKm / 6371
    overlayFields.earthLabel.textContent = label
    overlayFields.clockTime.textContent = `${formatTime(t.now)} (${DEFAULT_TIME_ZONE})`
    overlayFields.simTime.textContent = `${formatTime(t.sim)} (${DEFAULT_TIME_ZONE})`
    overlayFields.sunAltAz.textContent = `${hor.altitude.toFixed(1)}° / ${hor.azimuth.toFixed(1)}°`
    overlayFields.daylight.textContent = daylight ? 'daylight' : 'night'
    overlayFields.earthTilt.textContent = `${(OBLIQUITY_RAD * 180 / Math.PI).toFixed(1)}°`
    overlayFields.weatherLine.innerHTML = weatherLines.map((line) => `<div>${escapeHtml(line)}</div>`).join('')
    overlayFields.earthDistance.textContent = earthDistanceAU.toFixed(3)
    overlayFields.earthLongitude.textContent = `${((Math.atan2(earthGroup.position.z, earthGroup.position.x) * 180) / Math.PI).toFixed(1)}°`
    overlayFields.moonExaggeration.textContent = `${moonExaggeration}`
    overlayFields.moonDistance.textContent = moonDistanceKm.toFixed(0)
    overlayFields.moonEarthRadii.textContent = moonDistanceEarthRadii.toFixed(1)
    overlayFields.cosmicAge.textContent = ageGyr.toFixed(2)
    overlayFields.scaleFactor.textContent = a.toFixed(3)
    overlayFields.redshift.textContent = z.toFixed(2)
    overlayFields.galaxyCount.textContent = `${galaxySamples.length}`
    overlayFields.h0Fit.textContent = h0Fit.toFixed(1)
    overlayFields.hubbleOffset.textContent = `${hubbleFit.intercept >= 0 ? '+' : ''}${hubbleFit.intercept.toFixed(0)}`
    overlayFields.hubbleTime.textContent = ageFromH0.toFixed(2)
    overlayFields.epoch.textContent = epochLabel

    drawMoonInset(moonInsetCanvas, moonInsetCtx, moonVec)
  }
}

type WeatherState = {
  enabled: boolean
  lastFetchMs: number
  inflight: boolean
  lat: number
  lon: number
  tempC?: number
  windKph?: number
  code?: number
  isDay?: boolean
  updatedAt?: Date
  error?: string
}

function weatherCodeLabel(code: number | undefined) {
  if (code == null) return 'Unknown'
  // Open-Meteo weathercode mapping (subset)
  if (code === 0) return 'Clear'
  if (code === 1) return 'Mostly clear'
  if (code === 2) return 'Partly cloudy'
  if (code === 3) return 'Overcast'
  if (code === 45 || code === 48) return 'Fog'
  if (code === 51 || code === 53 || code === 55) return 'Drizzle'
  if (code === 61 || code === 63 || code === 65) return 'Rain'
  if (code === 66 || code === 67) return 'Freezing rain'
  if (code === 71 || code === 73 || code === 75) return 'Snow'
  if (code === 77) return 'Snow grains'
  if (code === 80 || code === 81 || code === 82) return 'Showers'
  if (code === 85 || code === 86) return 'Snow showers'
  if (code === 95) return 'Thunderstorm'
  if (code === 96 || code === 99) return 'Thunderstorm + hail'
  return `Code ${code}`
}

async function maybeFetchWeather(state: WeatherState, lat: number, lon: number, force = false) {
  if (!state.enabled) return
  const t = performance.now()
  const intervalMs = 10 * 60 * 1000 // 10 minutes

  const moved = Math.abs(state.lat - lat) + Math.abs(state.lon - lon) > 0.001
  if (moved) {
    state.lat = lat
    state.lon = lon
    state.updatedAt = undefined
    state.lastFetchMs = 0
  }

  if (state.inflight) return
  if (!force && t - state.lastFetchMs < intervalMs && state.updatedAt) return

  state.inflight = true
  state.error = undefined

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&current=temperature_2m,weather_code,wind_speed_10m,is_day&wind_speed_unit=kmh&temperature_unit=celsius`

  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) throw new Error(`Weather fetch failed: ${res.status}`)
    const json = await res.json()
    const cur = json.current
    state.tempC = typeof cur?.temperature_2m === 'number' ? cur.temperature_2m : undefined
    state.windKph = typeof cur?.wind_speed_10m === 'number' ? cur.wind_speed_10m : undefined
    state.code = typeof cur?.weather_code === 'number' ? cur.weather_code : undefined
    state.isDay = cur?.is_day === 1
    state.updatedAt = new Date()
    state.lastFetchMs = t
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e)
  } finally {
    state.inflight = false
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
      <div class="brand">
        <p class="eyebrow">Cosmic Clock</p>
        <h1>Earth, solar system, and universe in one view</h1>
      </div>
      <div class="hint">Drag to orbit • Scroll to zoom • Right-drag to pan • <a class="world-link" href="./world/">World globe</a></div>
    </header>
    <div id="panels"></div>
  `

  const panelsRoot = document.querySelector<HTMLDivElement>('#panels')!

  const showcaseShell = makePanelShell(panelsRoot, 'Earth · Solar System · Universe')

  const time = new TimeController()

  const weather: WeatherState = {
    enabled: true,
    lastFetchMs: 0,
    inflight: false,
    lat: DEFAULT_LAT,
    lon: DEFAULT_LON,
  }

  const params = {
    paused: false,
    speed: 1,
    resetNow: () => time.resetNow(),
    lat: DEFAULT_LAT,
    lon: DEFAULT_LON,

    // Earth
    earthTextureOffsetDeg: 180,

    // Universe panel
    cosmicAgeGyr: 13.8,

    // Weather
    weather: true,
    refreshWeather: () => {
      weather.lastFetchMs = 0
      void maybeFetchWeather(weather, params.lat, params.lon, true)
    },
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

  const universeFolder = gui.addFolder('Universe')
  universeFolder
    .add(params, 'cosmicAgeGyr', 0.1, 40, 0.1)
    .name('age (Gyr)')
  universeFolder.close()

  const locFolder = gui.addFolder('Location')
  locFolder
    .add(params, 'lat', -90, 90, 0.0001)
    .onChange(() => void maybeFetchWeather(weather, params.lat, params.lon, true))
  locFolder
    .add(params, 'lon', -180, 180, 0.0001)
    .onChange(() => void maybeFetchWeather(weather, params.lat, params.lon, true))
  locFolder.close()

  const weatherFolder = gui.addFolder('Weather')
  weatherFolder
    .add(params, 'weather')
    .name('enable')
    .onChange((v: boolean) => {
      weather.enabled = v
      if (v) void maybeFetchWeather(weather, params.lat, params.lon, true)
    })
  weatherFolder.add(params, 'refreshWeather').name('refresh now')
  weatherFolder.close()
  gui.close()
  time.paused = params.paused
  time.speed = params.speed

  const panel = makePanel('combined', showcaseShell)
  const galaxySamples = await loadGalaxySamples().catch((err) => {
    console.warn(err)
    return [] as GalaxySample[]
  })

  await buildCombinedPanel(panel, {
    getLat: () => params.lat,
    getLon: () => params.lon,
    getLabel: () => formatLocationLabel(params.lat, params.lon),
    getTextureOffsetDeg: () => params.earthTextureOffsetDeg,
    getCosmicAgeGyr: () => params.cosmicAgeGyr,
    galaxySamples,
    getWeatherLines: () => {
      if (!params.weather) return ['Weather: (disabled)']
      if (weather.error) return [`Weather: error (${weather.error})`]
      if (!weather.updatedAt) return [weather.inflight ? 'Weather: loading…' : 'Weather: (not loaded yet)']
      const desc = weatherCodeLabel(weather.code)
      const temp = weather.tempC != null ? `${weather.tempC.toFixed(1)}°C` : '—'
      const wind = weather.windKph != null ? `${weather.windKph.toFixed(0)} km/h` : '—'
      const asOf = weather.updatedAt ? `${weather.updatedAt.getHours().toString().padStart(2,'0')}:${weather.updatedAt.getMinutes().toString().padStart(2,'0')}` : '—'
      return [`Weather: ${desc} · ${temp} · wind ${wind} (as of ${asOf})`]
    },
  } as any)

  const ro = new ResizeObserver(() => panel.onResize())
  ro.observe(panel.root)
  panel.onResize()

  // Kick off first weather fetch
  weather.enabled = params.weather
  void maybeFetchWeather(weather, params.lat, params.lon, true)

  function frame() {
    const t = time.tick()

    // refresh weather occasionally (based on real time)
    void maybeFetchWeather(weather, params.lat, params.lon)

    panel.controls.update()
    panel.onFrame(t)
    panel.renderer.render(panel.scene, panel.camera)
    requestAnimationFrame(frame)
  }

  requestAnimationFrame(frame)
}

main().catch((err) => {
  console.error(err)
  const app = document.querySelector<HTMLDivElement>('#app')!
  app.textContent = String(err)
})
