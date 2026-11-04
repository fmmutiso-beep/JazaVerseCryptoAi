import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// Software WebGL Detection Guard
export const isSoftwareGl = (() => {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch (e) {
    return true;
  }
})();

// Module-level state & reusable math helpers (Zero GC in loop)
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _raycaster = new THREE.Raycaster();
const _mouse = new THREE.Vector2(-999, -999);

let renderer, scene, camera, controls;
let containerEl, canvasMountEl;
let animationFrameId = null;
let clock = new THREE.Clock();

let currentMode = 'mint'; // 'mint' | 'galaxy'
let currentCoin = null;
let currentFinish = 'gold'; // 'gold' | 'titanium' | 'cyber' | 'platinum'
let rotationSpeed = 1.0;
let explodeAmount = 0.0;
let targetExplode = 0.0;

let mintGroup = null;
let galaxyGroup = null;
let galaxyNodes = [];
let galaxyLines = null;

let cameraTargetPos = new THREE.Vector3(0, 1.2, 5.8);
let cameraTargetLook = new THREE.Vector3(0, 0, 0);
let isTransitioningCamera = false;

let cachedBrushedTexture = null;
let cachedShadowTexture = null;

// Material Finish Definitions (PBR Physical)
function getFinishSettings(preset) {
  switch (preset) {
    case 'titanium':
      return {
        color: 0x222c3c,
        metalness: 0.92,
        roughness: 0.24,
        clearcoat: 0.6,
        clearcoatRoughness: 0.2,
        emissive: 0x050b14,
        emissiveIntensity: 0.2
      };
    case 'cyber':
      return {
        color: 0x0284c7,
        metalness: 0.82,
        roughness: 0.26,
        clearcoat: 0.8,
        clearcoatRoughness: 0.15,
        emissive: 0x0369a1,
        emissiveIntensity: 0.35
      };
    case 'platinum':
      return {
        color: 0xe2e8f0,
        metalness: 0.98,
        roughness: 0.14,
        clearcoat: 0.7,
        clearcoatRoughness: 0.1,
        emissive: 0x1e293b,
        emissiveIntensity: 0.1
      };
    case 'gold':
    default:
      return {
        color: 0xf59e0b,
        metalness: 0.96,
        roughness: 0.16,
        clearcoat: 0.4,
        clearcoatRoughness: 0.2,
        emissive: 0xb45309,
        emissiveIntensity: 0.25
      };
  }
}

// Procedural Radial Brushed Coin Face Texture (Zero external 404 dependencies)
function getBrushedTexture() {
  if (cachedBrushedTexture) return cachedBrushedTexture;
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d');

  const cx = 512, cy = 512;
  const grad = ctx.createRadialGradient(cx, cy, 50, cx, cy, 510);
  grad.addColorStop(0, '#fde68a');
  grad.addColorStop(0.35, '#d97706');
  grad.addColorStop(0.7, '#fbbf24');
  grad.addColorStop(1, '#78350f');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 1024, 1024);

  // Concentric lathe grooves
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1.5;
  for (let r = 80; r < 500; r += 6) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Radial sunburst grain rays
  ctx.save();
  ctx.translate(cx, cy);
  for (let i = 0; i < 180; i++) {
    ctx.rotate((Math.PI * 2) / 180);
    ctx.fillStyle = i % 2 === 0 ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.05)';
    ctx.fillRect(0, 80, 2, 420);
  }
  ctx.restore();

  // Edge inscription ring
  ctx.beginPath();
  ctx.arc(cx, cy, 475, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
  ctx.lineWidth = 4;
  ctx.stroke();

  cachedBrushedTexture = new THREE.CanvasTexture(canvas);
  cachedBrushedTexture.colorSpace = THREE.SRGBColorSpace;
  cachedBrushedTexture.anisotropy = renderer ? renderer.capabilities.getMaxAnisotropy() : 8;
  return cachedBrushedTexture;
}

// Procedural Radial Soft Contact Shadow
function getShadowTexture() {
  if (cachedShadowTexture) return cachedShadowTexture;
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');

  const grad = ctx.createRadialGradient(256, 256, 10, 256, 256, 250);
  grad.addColorStop(0, 'rgba(0, 0, 0, 0.85)');
  grad.addColorStop(0.35, 'rgba(0, 0, 0, 0.45)');
  grad.addColorStop(0.7, 'rgba(0, 0, 0, 0.15)');
  grad.addColorStop(1, 'rgba(0, 0, 0, 0)');

  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 512, 512);

  cachedShadowTexture = new THREE.CanvasTexture(canvas);
  return cachedShadowTexture;
}

// 3D Procedural Embossed Crest (Bitcoin, Ethereum, Solana, and General)
function createEmblemGeometry(coinId, sym, finishPreset) {
  const emblemGroup = new THREE.Group();
  emblemGroup.name = 'emblemGroup';

  const finish = getFinishSettings(finishPreset);
  const crestMat = new THREE.MeshStandardMaterial({
    color: finish.color,
    metalness: Math.min(1.0, finish.metalness + 0.03),
    roughness: Math.max(0.08, finish.roughness - 0.06),
    emissive: finish.emissive,
    emissiveIntensity: finish.emissiveIntensity * 1.2
  });

  const id = String(coinId || '').toLowerCase();
  const s = String(sym || '').toUpperCase();

  if (id.includes('bitcoin') || s === 'BTC') {
    // Bitcoin 3D stylized relief insignia: vertical beveled bar + 2 loops + 4 serif spurs
    const barGeo = new THREE.BoxGeometry(0.3, 1.9, 0.16);
    const mainBar = new THREE.Mesh(barGeo, crestMat);
    mainBar.position.set(-0.35, 0, 0);
    emblemGroup.add(mainBar);

    // Two dual vertical pass-through spurs (top and bottom)
    const spurGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.45, 16);
    const spurT1 = new THREE.Mesh(spurGeo, crestMat);
    spurT1.position.set(-0.15, 1.05, 0);
    const spurT2 = new THREE.Mesh(spurGeo, crestMat);
    spurT2.position.set(0.15, 1.05, 0);
    const spurB1 = new THREE.Mesh(spurGeo, crestMat);
    spurB1.position.set(-0.15, -1.05, 0);
    const spurB2 = new THREE.Mesh(spurGeo, crestMat);
    spurB2.position.set(0.15, -1.05, 0);
    emblemGroup.add(spurT1, spurT2, spurB1, spurB2);

    // Upper B loop
    const upperLoopGeo = new THREE.TorusGeometry(0.48, 0.12, 16, 32, Math.PI);
    const upperLoop = new THREE.Mesh(upperLoopGeo, crestMat);
    upperLoop.rotation.z = -Math.PI / 2;
    upperLoop.position.set(-0.1, 0.42, 0);
    emblemGroup.add(upperLoop);

    // Lower B loop (slightly wider)
    const lowerLoopGeo = new THREE.TorusGeometry(0.55, 0.13, 16, 32, Math.PI);
    const lowerLoop = new THREE.Mesh(lowerLoopGeo, crestMat);
    lowerLoop.rotation.z = -Math.PI / 2;
    lowerLoop.position.set(-0.1, -0.42, 0);
    emblemGroup.add(lowerLoop);

  } else if (id.includes('ethereum') || s === 'ETH') {
    // Ethereum: Double faceted octahedral diamond gemstone prism
    const topGemGeo = new THREE.ConeGeometry(0.9, 1.45, 4);
    const topGem = new THREE.Mesh(topGemGeo, crestMat);
    topGem.rotation.y = Math.PI / 4;
    topGem.position.set(0, 0.4, 0);

    const bottomGemGeo = new THREE.ConeGeometry(0.9, 0.85, 4);
    const bottomGem = new THREE.Mesh(bottomGemGeo, crestMat);
    bottomGem.rotation.y = Math.PI / 4;
    bottomGem.rotation.x = Math.PI;
    bottomGem.position.set(0, -0.65, 0);

    emblemGroup.add(topGem, bottomGem);

  } else if (id.includes('solana') || s === 'SOL') {
    // Solana: Three tiered parallel parallelogram blades
    const bladeGeo = new THREE.BoxGeometry(1.65, 0.22, 0.14);
    for (let b = 0; b < 3; b++) {
      const blade = new THREE.Mesh(bladeGeo, crestMat);
      blade.position.set((b - 1) * 0.12, (1 - b) * 0.55, 0);
      blade.rotation.z = -0.32;
      emblemGroup.add(blade);
    }

  } else if (id.includes('cardano') || s === 'ADA') {
    // Cardano: Concentric circular radial node array
    const centerGeo = new THREE.CylinderGeometry(0.38, 0.38, 0.16, 32);
    const center = new THREE.Mesh(centerGeo, crestMat);
    emblemGroup.add(center);

    const nodeCount = 6;
    const nodeGeo = new THREE.SphereGeometry(0.18, 16, 16);
    for (let k = 0; k < nodeCount; k++) {
      const angle = (k / nodeCount) * Math.PI * 2;
      const node = new THREE.Mesh(nodeGeo, crestMat);
      node.position.set(Math.cos(angle) * 1.0, Math.sin(angle) * 1.0, 0);
      emblemGroup.add(node);
    }

  } else if (id.includes('ripple') || s === 'XRP') {
    // XRP: Chevron wings
    const wingGeo = new THREE.TorusGeometry(0.75, 0.14, 16, 32, Math.PI * 0.85);
    const w1 = new THREE.Mesh(wingGeo, crestMat);
    w1.rotation.z = -Math.PI * 0.42;
    w1.position.set(0, 0.4, 0);
    const w2 = new THREE.Mesh(wingGeo, crestMat);
    w2.rotation.z = Math.PI * 0.58;
    w2.position.set(0, -0.4, 0);
    emblemGroup.add(w1, w2);

  } else {
    // Multi-faceted geometric star medallion for all other coins
    const hubGeo = new THREE.CylinderGeometry(0.55, 0.55, 0.15, 32);
    const hub = new THREE.Mesh(hubGeo, crestMat);
    emblemGroup.add(hub);

    const rayCount = 8;
    const rayGeo = new THREE.ConeGeometry(0.18, 0.9, 4);
    for (let r = 0; r < rayCount; r++) {
      const angle = (r / rayCount) * Math.PI * 2;
      const ray = new THREE.Mesh(rayGeo, crestMat);
      ray.position.set(Math.cos(angle) * 0.95, Math.sin(angle) * 0.95, 0);
      ray.rotation.z = angle - Math.PI / 2;
      emblemGroup.add(ray);
    }
  }

  return emblemGroup;
}

// Composite 3–12 Part Procedural Coin Model (THREE.Group)
export function createCoinModel(coinData, finishPreset) {
  const group = new THREE.Group();
  group.name = 'coinModel';

  const finish = getFinishSettings(finishPreset);

  // 1. Core milled edge cylinder (Primary silhouette)
  const coreGeo = new THREE.CylinderGeometry(2.35, 2.35, 0.32, 64);
  const coreMat = new THREE.MeshStandardMaterial({
    color: finish.color,
    metalness: finish.metalness,
    roughness: finish.roughness,
    emissive: finish.emissive,
    emissiveIntensity: finish.emissiveIntensity
  });
  const coreMesh = new THREE.Mesh(coreGeo, coreMat);
  coreMesh.rotation.x = Math.PI / 2;
  coreMesh.castShadow = !isSoftwareGl;
  coreMesh.receiveShadow = !isSoftwareGl;
  group.add(coreMesh);

  // Milled perimeter teeth (Secondary read - 48 teeth)
  const teethGroup = new THREE.Group();
  teethGroup.name = 'teethGroup';
  const toothGeo = new THREE.BoxGeometry(0.05, 0.32, 0.09);
  const toothMat = new THREE.MeshStandardMaterial({
    color: finish.color,
    metalness: finish.metalness,
    roughness: Math.max(0.1, finish.roughness - 0.05)
  });
  const teethCount = 48;
  for (let i = 0; i < teethCount; i++) {
    const angle = (i / teethCount) * Math.PI * 2;
    const tooth = new THREE.Mesh(toothGeo, toothMat);
    tooth.position.set(Math.cos(angle) * 2.37, Math.sin(angle) * 2.37, 0);
    tooth.rotation.z = angle;
    teethGroup.add(tooth);
  }
  group.add(teethGroup);

  // 2. Raised outer rim beveled toruses (Front & Back)
  const rimGeo = new THREE.TorusGeometry(2.32, 0.07, 16, 64);
  const rimMat = new THREE.MeshStandardMaterial({
    color: finish.color,
    metalness: finish.metalness,
    roughness: Math.max(0.08, finish.roughness - 0.08),
    clearcoat: finish.clearcoat,
    clearcoatRoughness: finish.clearcoatRoughness
  });

  const frontRim = new THREE.Mesh(rimGeo, rimMat);
  frontRim.position.z = 0.16;
  group.add(frontRim);

  const backRim = new THREE.Mesh(rimGeo, rimMat);
  backRim.position.z = -0.16;
  group.add(backRim);

  // 3. Recessed coin face plates with procedural radial brushed texture
  const brushedTex = getBrushedTexture();
  const faceGeo = new THREE.CircleGeometry(2.26, 64);
  const faceMat = new THREE.MeshStandardMaterial({
    color: finish.color,
    metalness: finish.metalness,
    roughness: finish.roughness,
    map: brushedTex
  });

  const frontFace = new THREE.Mesh(faceGeo, faceMat);
  frontFace.position.z = 0.165;
  group.add(frontFace);

  const backFace = new THREE.Mesh(faceGeo, faceMat);
  backFace.position.z = -0.165;
  backFace.rotation.y = Math.PI;
  group.add(backFace);

  // 4. Embossed 3D Emblem Crest
  const emblemGroup = createEmblemGeometry(coinData.id, coinData.sym, finishPreset);
  emblemGroup.position.z = 0.20;
  group.add(emblemGroup);

  // 5. Floating kinetic energy halo ring with orbital nodes
  const isUp = (coinData.ch24 || 0) >= 0;
  const haloGeo = new THREE.TorusGeometry(3.15, 0.02, 16, 96);
  const haloMat = new THREE.MeshStandardMaterial({
    color: isUp ? 0x22c55e : 0xef4444,
    emissive: isUp ? 0x16a34a : 0xdc2626,
    emissiveIntensity: 0.75,
    metalness: 0.9,
    roughness: 0.2
  });
  const haloMesh = new THREE.Mesh(haloGeo, haloMat);
  haloMesh.rotation.x = 0.45;
  haloMesh.name = 'orbitalHalo';
  group.add(haloMesh);

  // Orbital satellite data nodes
  const satGeo = new THREE.IcosahedronGeometry(0.12, 1);
  const satMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: isUp ? 0x4ade80 : 0xf87171,
    emissiveIntensity: 0.9,
    metalness: 0.95,
    roughness: 0.1
  });
  const satCount = 3;
  const satNodes = [];
  for (let s = 0; s < satCount; s++) {
    const sat = new THREE.Mesh(satGeo, satMat);
    haloMesh.add(sat);
    satNodes.push(sat);
  }

  // 6. Contact shadow plane grounded below
  const shadowGeo = new THREE.PlaneGeometry(8, 8);
  const shadowMat = new THREE.MeshBasicMaterial({
    map: getShadowTexture(),
    transparent: true,
    opacity: 0.48,
    depthWrite: false
  });
  const shadowMesh = new THREE.Mesh(shadowGeo, shadowMat);
  shadowMesh.position.y = -2.6;
  shadowMesh.rotation.x = -Math.PI / 2;
  group.add(shadowMesh);

  // 7. Base pedestal laser ring
  const gridGeo = new THREE.RingGeometry(2.8, 3.8, 64);
  const gridMat = new THREE.MeshBasicMaterial({
    color: 0x38bdf8,
    transparent: true,
    opacity: 0.18,
    side: THREE.DoubleSide
  });
  const gridMesh = new THREE.Mesh(gridGeo, gridMat);
  gridMesh.position.y = -2.59;
  gridMesh.rotation.x = -Math.PI / 2;
  group.add(gridMesh);

  // Save component references for exploded animation
  group.userData = {
    frontRim,
    backRim,
    frontFace,
    backFace,
    emblemGroup,
    haloMesh,
    satNodes,
    teethGroup,
    coreMesh
  };

  return group;
}

// 3D Market Galaxy Mode (Interactive Space Constellation)
export function createGalaxyScene(coinsList) {
  const group = new THREE.Group();
  group.name = 'galaxyGroup';
  galaxyNodes = [];

  const topCoins = (coinsList || []).filter(c => c.price > 0).slice(0, 36);
  if (!topCoins.length) return group;

  // Interconnecting constellation lines
  const linePoints = [];
  const coords = [];

  topCoins.forEach((c, i) => {
    // Spherical distribution with radius varying by market cap
    const phi = Math.acos(-1 + (2 * i) / topCoins.length);
    const theta = Math.sqrt(topCoins.length * Math.PI) * phi;
    const dist = 6.5 + (i % 3) * 1.8;

    const x = dist * Math.cos(theta) * Math.sin(phi);
    const y = dist * Math.sin(theta) * Math.sin(phi) * 0.75;
    const z = dist * Math.cos(phi);
    coords.push(new THREE.Vector3(x, y, z));

    // Composite node representation
    const nodeGroup = new THREE.Group();
    nodeGroup.position.set(x, y, z);
    nodeGroup.userData = { coin: c, baseScale: 1.0 };

    const isUp = (c.ch24 || 0) >= 0;
    const nodeColor = isUp ? 0x22c55e : 0xef4444;
    const emissiveColor = isUp ? 0x15803d : 0x991b1b;

    // Node crystal sphere
    const size = Math.max(0.35, Math.min(0.9, 0.35 + Math.log10(Math.max(c.mcap || 1e6, 1e6)) * 0.05));
    const sphereGeo = new THREE.IcosahedronGeometry(size, 2);
    const sphereMat = new THREE.MeshStandardMaterial({
      color: nodeColor,
      emissive: emissiveColor,
      emissiveIntensity: 0.6,
      metalness: 0.85,
      roughness: 0.2
    });
    const sphereMesh = new THREE.Mesh(sphereGeo, sphereMat);
    sphereMesh.userData = { coin: c };
    nodeGroup.add(sphereMesh);

    // Glowing orbital halo
    const ringGeo = new THREE.TorusGeometry(size * 1.5, 0.02, 12, 36);
    const ringMat = new THREE.MeshBasicMaterial({
      color: nodeColor,
      transparent: true,
      opacity: 0.7
    });
    const ringMesh = new THREE.Mesh(ringGeo, ringMat);
    ringMesh.rotation.x = Math.random() * Math.PI;
    ringMesh.rotation.y = Math.random() * Math.PI;
    nodeGroup.add(ringMesh);

    group.add(nodeGroup);
    galaxyNodes.push(nodeGroup);
  });

  // Connect nearest neighbors with subtle laser lines
  for (let a = 0; a < coords.length; a++) {
    for (let b = a + 1; b < coords.length; b++) {
      if (coords[a].distanceTo(coords[b]) < 4.5) {
        linePoints.push(coords[a].x, coords[a].y, coords[a].z);
        linePoints.push(coords[b].x, coords[b].y, coords[b].z);
      }
    }
  }

  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(linePoints, 3));
  const lineMat = new THREE.LineBasicMaterial({
    color: 0x38bdf8,
    transparent: true,
    opacity: 0.18
  });
  galaxyLines = new THREE.LineSegments(lineGeo, lineMat);
  group.add(galaxyLines);

  // Background star field
  const starCount = isSoftwareGl ? 300 : 800;
  const starPoints = [];
  for (let s = 0; s < starCount; s++) {
    starPoints.push(
      (Math.random() - 0.5) * 60,
      (Math.random() - 0.5) * 60,
      (Math.random() - 0.5) * 60
    );
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPoints, 3));
  const starMat = new THREE.PointsMaterial({
    color: 0x94a3b8,
    size: 0.12,
    transparent: true,
    opacity: 0.6
  });
  const stars = new THREE.Points(starGeo, starMat);
  group.add(stars);

  return group;
}

let isScreensaverMode = false;

// Master Initialization of the 3D Screensaver
export async function initThreeVault(mountEl, getCoinsFn, onSelectCoinFn) {
  // Helper to build controller instance
  const makeController = () => ({
    selectCoin: (coinOrId) => {
      const coins = getCoinsFn ? getCoinsFn() : [];
      const c = typeof coinOrId === 'string' ? (coins.find(x => x.id === coinOrId) || { id: coinOrId, name: coinOrId, sym: coinOrId.toUpperCase() }) : coinOrId;
      setThreeCoin(c);
    },
    getCurrentCoin: () => currentCoin,
    setMode: setThreeMode,
    setFinish: setThreeFinish,
    setExplode: setThreeExplode,
    setRotationSpeed: setThreeSpeed,
    setCameraPreset: setThreeCamera,
    setScreensaver: (active) => {
      isScreensaverMode = !!active;
      if (active) {
        currentMode = 'mint';
        if (mintGroup) mintGroup.visible = true;
        if (galaxyGroup) galaxyGroup.visible = false;
        cameraTargetPos.set(0, 0.25, 5.2);
        cameraTargetLook.set(0, 0, 0);
        camera.position.set(0, 0.25, 5.2);
        controls.target.set(0, 0, 0);
        controls.update();
        isTransitioningCamera = false;
      }
      handleResize();
      setTimeout(handleResize, 50);
    },
    isScreensaver: () => isScreensaverMode,
    setMount: (newMountEl) => {
      if (!newMountEl || !renderer) return;
      canvasMountEl = newMountEl;
      containerEl = newMountEl.parentElement;
      newMountEl.appendChild(renderer.domElement);
      handleResize();
      requestAnimationFrame(handleResize);
      setTimeout(handleResize, 30);
      setTimeout(handleResize, 150);
    },
    resize: handleResize
  });

  if (renderer) {
    if (mountEl && canvasMountEl !== mountEl) {
      canvasMountEl = mountEl;
      mountEl.appendChild(renderer.domElement);
      handleResize();
      setTimeout(handleResize, 10);
    }
    return makeController();
  }

  // Scene
  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x0b1120, 0.022);

  // Camera - resilient dimension fallback so aspect is never NaN
  canvasMountEl = mountEl;
  const w = (mountEl && mountEl.clientWidth) || window.innerWidth || 800;
  const h = (mountEl && mountEl.clientHeight) || window.innerHeight || 600;
  const aspect = Math.max(0.1, w / (h || 1));
  camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 100);
  camera.position.copy(cameraTargetPos);

  // WebGL Renderer with High-Performance & Tone Mapping
  renderer = new THREE.WebGLRenderer({
    antialias: !isSoftwareGl,
    powerPreference: 'high-performance',
    alpha: true
  });
  renderer.setSize(w, h);
  renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.shadowMap.enabled = !isSoftwareGl;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.className = 'three-canvas';
  mountEl.appendChild(renderer.domElement);

  // Procedural Studio Environment Reflection (RoomEnvironment)
  try {
    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    pmremGenerator.compileEquirectangularShader();
    scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
    pmremGenerator.dispose();
  } catch (e) {
    console.warn('RoomEnvironment generation fallback:', e);
  }

  // Balanced 3-Point Studio Lighting Rig with Specular Rim Accent
  const keyLight = new THREE.DirectionalLight(0xfff5e6, 2.6);
  keyLight.position.set(5.5, 7.5, 6.0);
  if (!isSoftwareGl) {
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.width = 1024;
    keyLight.shadow.mapSize.height = 1024;
    keyLight.shadow.bias = -0.0005;
    keyLight.shadow.normalBias = 0.02;
    keyLight.shadow.camera.left = -4;
    keyLight.shadow.camera.right = 4;
    keyLight.shadow.camera.top = 4;
    keyLight.shadow.camera.bottom = -4;
  }
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0x60a5fa, 1.4);
  fillLight.position.set(-6.0, -2.0, -5.0);
  scene.add(fillLight);

  const rimLight = new THREE.DirectionalLight(0xf59e0b, 1.8);
  rimLight.position.set(0, 4.0, -5.0);
  scene.add(rimLight);

  const hemiLight = new THREE.HemisphereLight(0x38bdf8, 0x0b1120, 0.75);
  scene.add(hemiLight);

  // OrbitControls with exponential damping
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.maxDistance = 24;
  controls.minDistance = 2;
  controls.maxPolarAngle = Math.PI / 2 + 0.15; // don't go too far below floor
  controls.target.copy(cameraTargetLook);

  // Window Resize Listener
  window.addEventListener('resize', handleResize);

  // Pointer Interaction (Raycasting for Galaxy View)
  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('pointerdown', onPointerDown);

  // Initial Scene Population
  const coins = getCoinsFn ? getCoinsFn() : [];
  currentCoin = coins[0] || { id: 'bitcoin', sym: 'BTC', name: 'Bitcoin', price: 98000, ch24: 2.4, mc: 87.2, rating: { label: 'High Quality' } };

  // Build initial 3D Coin Model
  mintGroup = createCoinModel(currentCoin, currentFinish);
  scene.add(mintGroup);

  // Build initial Galaxy scene (hidden initially)
  galaxyGroup = createGalaxyScene(coins);
  galaxyGroup.visible = false;
  scene.add(galaxyGroup);

  // Start smooth 60fps render loop
  startRenderLoop();

  return makeController();
}

function handleResize() {
  if (!renderer) return;
  let w = canvasMountEl ? canvasMountEl.clientWidth : 0;
  let h = canvasMountEl ? canvasMountEl.clientHeight : 0;
  if (!w || !h) {
    if (canvasMountEl && (canvasMountEl.id === 'screensaverMount' || canvasMountEl.classList.contains('screensaver-mount'))) {
      w = window.innerWidth;
      h = window.innerHeight;
    } else {
      w = window.innerWidth || 800;
      h = window.innerHeight || 600;
    }
  }
  if (!w || !h) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

// Raycasting Pointer Events
function onPointerMove(e) {
  if (currentMode !== 'galaxy' || !galaxyNodes.length) return;
  const rect = renderer.domElement.getBoundingClientRect();
  _mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  _mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

  _raycaster.setFromCamera(_mouse, camera);
  const meshes = galaxyNodes.map(g => g.children[0]).filter(Boolean);
  const intersects = _raycaster.intersectObjects(meshes, false);

  const tooltip = document.getElementById('threeTooltip');
  if (intersects.length > 0) {
    const hit = intersects[0].object;
    const c = hit.userData.coin;
    if (c && tooltip) {
      tooltip.style.display = 'block';
      tooltip.style.left = `${e.clientX - rect.left}px`;
      tooltip.style.top = `${e.clientY - rect.top}px`;
      tooltip.innerHTML = `<strong>${c.name} (${c.sym})</strong><br>Price: $${c.price.toLocaleString()}<br>24h: <span style="color:${c.ch24 >= 0 ? '#4ade80' : '#f87171'}">${c.ch24 >= 0 ? '+' : ''}${c.ch24.toFixed(2)}%</span> · Score: ${c.mc.toFixed(1)}`;
      renderer.domElement.style.cursor = 'pointer';
    }
  } else {
    if (tooltip) tooltip.style.display = 'none';
    renderer.domElement.style.cursor = 'default';
  }
}

function onPointerDown(e) {
  if (currentMode !== 'galaxy' || !galaxyNodes.length) return;
  const rect = renderer.domElement.getBoundingClientRect();
  _mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  _mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

  _raycaster.setFromCamera(_mouse, camera);
  const meshes = galaxyNodes.map(g => g.children[0]).filter(Boolean);
  const intersects = _raycaster.intersectObjects(meshes, false);

  if (intersects.length > 0) {
    const hit = intersects[0].object;
    const c = hit.userData.coin;
    if (c) {
      setThreeCoin(c);
      setThreeMode('mint');
      const mintBtn = document.getElementById('threeModeMint');
      const galBtn = document.getElementById('threeModeGalaxy');
      if (mintBtn && galBtn) {
        mintBtn.setAttribute('aria-pressed', 'true');
        galBtn.setAttribute('aria-pressed', 'false');
      }
    }
  }
}

// Silky-Smooth 60fps Animation Loop with Continuous Rotation & Specular Physics
function startRenderLoop() {
  function tick() {
    animationFrameId = requestAnimationFrame(tick);
    const delta = clock.getDelta();
    const time = clock.getElapsedTime();

    // Smooth Camera Transition (glides to preset positions)
    if (isTransitioningCamera) {
      camera.position.lerp(cameraTargetPos, 1.0 - Math.exp(-6.0 * delta));
      controls.target.lerp(cameraTargetLook, 1.0 - Math.exp(-6.0 * delta));
      if (camera.position.distanceTo(cameraTargetPos) < 0.05) {
        isTransitioningCamera = false;
      }
    }

    controls.update();

    // Mode A: Token Mint & Screensaver 3D Rotating Coin Animations
    if ((currentMode === 'mint' || isScreensaverMode) && mintGroup) {
      // Rotation: active, steady, and visible
      const spinSpeed = isScreensaverMode ? 1.4 : (rotationSpeed > 0 ? 0.8 * rotationSpeed : 0);
      if (spinSpeed > 0) {
        mintGroup.rotation.y += spinSpeed * Math.min(delta, 0.1);
      }

      // Elegant levitation bob & precession angle in screensaver
      if (isScreensaverMode) {
        mintGroup.position.y = Math.sin(time * 1.5) * 0.14;
        mintGroup.rotation.x = Math.sin(time * 0.8) * 0.08 + 0.04;
        mintGroup.rotation.z = Math.cos(time * 0.6) * 0.03;
      } else {
        mintGroup.position.y = 0;
      }

      // Smooth Exploded-View Kinematics (Exponential Damping)
      explodeAmount += (targetExplode - explodeAmount) * (1.0 - Math.exp(-8.0 * delta));
      const u = mintGroup.userData;
      if (u) {
        const expDist = explodeAmount * 1.5;
        if (u.frontRim) u.frontRim.position.z = 0.16 + expDist * 0.7;
        if (u.backRim) u.backRim.position.z = -0.16 - expDist * 0.7;
        if (u.frontFace) u.frontFace.position.z = 0.165 + expDist * 1.0;
        if (u.backFace) u.backFace.position.z = -0.165 - expDist * 1.0;
        if (u.emblemGroup) u.emblemGroup.position.z = 0.20 + expDist * 1.4;
        if (u.haloMesh) {
          u.haloMesh.scale.setScalar(1.0 + explodeAmount * 0.35);
          u.haloMesh.rotation.z += 0.8 * delta;
          u.haloMesh.rotation.y += 0.35 * delta;
        }

        // Animate satellite nodes on the energy halo
        if (u.satNodes && u.satNodes.length) {
          u.satNodes.forEach((sat, idx) => {
            const satAngle = time * 1.8 + (idx * Math.PI * 2) / u.satNodes.length;
            sat.position.set(Math.cos(satAngle) * 3.15, Math.sin(satAngle) * 3.15, 0);
          });
        }
      }
    }

    // Mode B: Galaxy Constellation Animations
    if (currentMode === 'galaxy' && !isScreensaverMode && galaxyGroup) {
      galaxyGroup.rotation.y += 0.06 * rotationSpeed * delta;
      // Gentle floating bob on nodes
      galaxyNodes.forEach((node, i) => {
        node.position.y += Math.sin(time * 1.5 + i) * 0.003;
      });
    }

    renderer.render(scene, camera);
  }

  tick();
}

// Public Control API
export function setThreeCoin(coinData) {
  currentCoin = coinData;
  if (mintGroup && scene) {
    scene.remove(mintGroup);
    // Dispose old geometries & materials
    mintGroup.traverse(obj => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
        else obj.material.dispose();
      }
    });
    mintGroup = createCoinModel(currentCoin, currentFinish);
    scene.add(mintGroup);
  }
  updateBadgeUI();
}

export function setThreeMode(mode) {
  currentMode = mode;
  if (mode === 'mint') {
    if (mintGroup) mintGroup.visible = true;
    if (galaxyGroup) galaxyGroup.visible = false;
    setThreeCamera('hero');
  } else {
    if (mintGroup) mintGroup.visible = false;
    if (galaxyGroup) galaxyGroup.visible = true;
    setThreeCamera('galaxy');
  }
}

export function setThreeFinish(preset) {
  currentFinish = preset;
  if (currentCoin) setThreeCoin(currentCoin);
}

export function setThreeExplode(valPct) {
  targetExplode = Math.max(0, Math.min(100, valPct)) / 100.0;
}

export function setThreeSpeed(val) {
  rotationSpeed = parseFloat(val) || 0;
}

export function setThreeCamera(preset) {
  isTransitioningCamera = true;
  switch (preset) {
    case 'face':
      cameraTargetPos.set(0, 0, 5.2);
      cameraTargetLook.set(0, 0, 0);
      break;
    case 'edge':
      cameraTargetPos.set(5.0, 0, 0.4);
      cameraTargetLook.set(0, 0, 0);
      break;
    case 'iso':
      cameraTargetPos.set(4.2, 4.2, 4.2);
      cameraTargetLook.set(0, 0, 0);
      break;
    case 'galaxy':
      cameraTargetPos.set(0, 3.5, 14.5);
      cameraTargetLook.set(0, 0, 0);
      break;
    case 'hero':
    default:
      cameraTargetPos.set(0, 1.2, 5.8);
      cameraTargetLook.set(0, 0, 0);
      break;
  }
}

function updateBadgeUI() {
  if (!currentCoin) return;
  const title = document.getElementById('threeBadgeTitle');
  const sub = document.getElementById('threeBadgeSub');
  const price = document.getElementById('threeBadgePrice');
  const change = document.getElementById('threeBadgeChange');

  if (title) title.innerHTML = `<span>${currentCoin.name}</span> <span class="type">${currentCoin.sym}</span>`;
  if (sub) sub.textContent = `CEM-100 Score ${(currentCoin.mc || 0).toFixed(1)} · ${(currentCoin.rating && currentCoin.rating.label) || 'Evaluation'}`;
  if (price) price.textContent = `$${(currentCoin.price || 0).toLocaleString()}`;
  if (change) {
    const isUp = (currentCoin.ch24 || 0) >= 0;
    change.className = isUp ? 'up' : 'down';
    change.textContent = `${isUp ? '+' : ''}${(currentCoin.ch24 || 0).toFixed(2)}%`;
  }

  // Update screensaver badge with clean text
  const scName = document.getElementById('scName');
  const scSym = document.getElementById('scSym');
  const scPrice = document.getElementById('scPrice');
  const scChg = document.getElementById('scChg');
  const scScore = document.getElementById('scScore');
  const scRating = document.getElementById('scRating');

  if (scName) scName.textContent = currentCoin.name || 'Bitcoin';
  if (scSym) scSym.textContent = currentCoin.sym || 'BTC';
  if (scPrice) scPrice.textContent = `$${Number(currentCoin.price || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (scChg) {
    const isUp = (currentCoin.ch24 || 0) >= 0;
    const arrow = isUp ? '▲' : '▼';
    scChg.style.color = isUp ? '#22c55e' : '#ef4444';
    scChg.textContent = `${arrow} ${isUp ? '+' : ''}${Number(currentCoin.ch24 || 0).toFixed(2)}%`;
  }
  if (scScore) scScore.textContent = `MC Score ${(currentCoin.mc || 0).toFixed(1)}`;
  if (scRating) scRating.textContent = (currentCoin.rating && currentCoin.rating.label) || 'High Quality';
}

export function refreshGalaxyCoins(coinsList) {
  if (!scene) return;
  if (galaxyGroup) {
    scene.remove(galaxyGroup);
  }
  galaxyGroup = createGalaxyScene(coinsList);
  galaxyGroup.visible = (currentMode === 'galaxy');
  scene.add(galaxyGroup);
}
