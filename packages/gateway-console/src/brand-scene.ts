/*
 * Sign-in brand scene: a machined Gateway unit on an anodized base plate.
 * Bot nodes on the left and devices on the right are joined by lit channels
 * cut into the plate; request pulses travel along them, and the Gateway's
 * stage band flashes as each one passes through. Purely decorative: it uses
 * fixed geometry and never reads Gateway data.
 *
 * Loaded with a dynamic import so three.js is a separate chunk that only the
 * sign-in page downloads.
 */
import {
  ACESFilmicToneMapping,
  AmbientLight,
  CapsuleGeometry,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  Fog,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Material,
} from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";

export interface BrandScene {
  dispose(): void;
}

const palette = {
  graphite: new Color("#151b1e"),
  plate: new Color("#1a2125"),
  aluminium: new Color("#c4ccd0"),
  ceramic: new Color("#c9d2d6"),
  device: new Color("#3a4448"),
  channel: new Color("#3fb6c4"),
  read: new Color("#6e9bff"),
  write: new Color("#f0a93a"),
  exec: new Color("#a88df6"),
};

const lanes = [-1.45, 0, 1.45];
const stageHeights = [0.62, 1.07, 1.52];
const gatewayHalf = 0.78;

/** A channel from a bot, into the Gateway, and out to a device. */
function route(from: number, to: number): CatmullRomCurve3 {
  const y = 0.03;
  return new CatmullRomCurve3([
    new Vector3(-3.15, y, lanes[from]),
    new Vector3(-2.2, y, lanes[from] * 0.92),
    new Vector3(-1.35, y, lanes[from] * 0.35),
    new Vector3(-gatewayHalf, y, lanes[from] * 0.18),
    new Vector3(gatewayHalf, y, lanes[to] * 0.18),
    new Vector3(1.35, y, lanes[to] * 0.35),
    new Vector3(2.2, y, lanes[to] * 0.92),
    new Vector3(3.15, y, lanes[to]),
  ], false, "centripetal");
}

const routes: Array<{ from: number; to: number; color: Color; stage: number; speed: number; offset: number }> = [
  { from: 0, to: 1, color: palette.read, stage: 0, speed: 0.11, offset: 0.0 },
  { from: 1, to: 0, color: palette.write, stage: 1, speed: 0.09, offset: 0.35 },
  { from: 2, to: 2, color: palette.read, stage: 2, speed: 0.12, offset: 0.62 },
  { from: 1, to: 2, color: palette.exec, stage: 1, speed: 0.08, offset: 0.85 },
  { from: 0, to: 0, color: palette.read, stage: 0, speed: 0.1, offset: 0.5 },
];

export function mountBrandScene(host: HTMLElement, { still }: { still: boolean }): BrandScene {
  // Throws where WebGL is unavailable; the caller keeps its 2D fallback.
  const renderer = new WebGLRenderer({ antialias: true, powerPreference: "low-power" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.92;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  renderer.domElement.setAttribute("aria-hidden", "true");
  renderer.domElement.className = "brand-scene-canvas";
  host.appendChild(renderer.domElement);

  const scene = new Scene();
  scene.background = palette.graphite;
  scene.fog = new Fog(palette.graphite, 11, 22);
  const pmrem = new PMREMGenerator(renderer);
  const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = environment;
  scene.environmentIntensity = 0.45;

  const disposables: Array<{ dispose(): void }> = [pmrem, environment];
  const keep = <T extends { dispose(): void }>(value: T): T => { disposables.push(value); return value; };

  // Lighting: warm key with soft shadows, cool rim from behind, low fill.
  scene.add(new AmbientLight("#9fb4bb", 0.18));
  const key = new DirectionalLight("#fff3e6", 1.7);
  key.position.set(-4.5, 9, 5.5);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -6;
  key.shadow.camera.right = 6;
  key.shadow.camera.top = 5;
  key.shadow.camera.bottom = -5;
  key.shadow.radius = 6;
  key.shadow.bias = -0.0004;
  scene.add(key);
  const rim = new DirectionalLight("#4fb4c2", 1.6);
  rim.position.set(3, 3.5, -7);
  scene.add(rim);

  const world = new Group();
  scene.add(world);

  // Floor and anodized base plate.
  const floor = new Mesh(keep(new PlaneGeometry(60, 60)), keep(new MeshStandardMaterial({ color: "#11171a", roughness: 0.92, metalness: 0.1 })));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.32;
  floor.receiveShadow = true;
  world.add(floor);
  const plate = new Mesh(
    keep(new RoundedBoxGeometry(8.4, 0.28, 4.6, 6, 0.12)),
    keep(new MeshPhysicalMaterial({ color: palette.plate, metalness: 0.7, roughness: 0.5, clearcoat: 0.25, clearcoatRoughness: 0.6, envMapIntensity: 0.35 })),
  );
  plate.position.y = -0.14;
  plate.receiveShadow = true;
  plate.castShadow = true;
  world.add(plate);

  // Machined details: an engraved border and four corner screws.
  const engraving = keep(new MeshStandardMaterial({ color: "#0e1416", roughness: 0.7, metalness: 0.4 }));
  for (const [w, d, x, z] of [[7.9, 0.03, 0, 2.05], [7.9, 0.03, 0, -2.05], [0.03, 4.1, 3.95, 0], [0.03, 4.1, -3.95, 0]] as const) {
    const line = new Mesh(keep(new RoundedBoxGeometry(w, 0.012, d, 1, 0.004)), engraving);
    line.position.set(x, 0.002, z);
    world.add(line);
  }
  const screwMaterial = keep(new MeshPhysicalMaterial({ color: "#8d979b", metalness: 1, roughness: 0.25 }));
  const screwGeometry = keep(new CylinderGeometry(0.07, 0.07, 0.03, 24));
  const slotGeometry = keep(new RoundedBoxGeometry(0.1, 0.012, 0.018, 1, 0.004));
  for (const [x, z] of [[-3.85, -1.95], [3.85, -1.95], [-3.85, 1.95], [3.85, 1.95]]) {
    const screw = new Mesh(screwGeometry, screwMaterial);
    screw.position.set(x, 0.012, z);
    const slot = new Mesh(slotGeometry, engraving);
    slot.position.set(x, 0.03, z);
    slot.rotation.y = 0.6;
    world.add(screw, slot);
  }

  // Channels: a dark groove with a faint lit core.
  const grooveMaterial = keep(new MeshStandardMaterial({ color: "#0d1214", roughness: 0.8, metalness: 0.2 }));
  const channelMaterial = keep(new MeshStandardMaterial({ color: "#0f2a2e", emissive: palette.channel, emissiveIntensity: 0.32, roughness: 0.4 }));
  const curves = routes.map((entry) => route(entry.from, entry.to));
  for (const curve of curves) {
    const groove = new Mesh(keep(new TubeGeometry(curve, 160, 0.042, 8)), grooveMaterial);
    groove.scale.y = 0.35;
    world.add(groove);
    world.add(new Mesh(keep(new TubeGeometry(curve, 160, 0.016, 8)), channelMaterial));
  }

  // Gateway unit: brushed aluminium with three stage bands.
  const aluminium = keep(new MeshPhysicalMaterial({ color: palette.aluminium, metalness: 1, roughness: 0.34, clearcoat: 0.4, clearcoatRoughness: 0.3, envMapIntensity: 0.8 }));
  const gateway = new Mesh(keep(new RoundedBoxGeometry(1.56, 2.1, 1.56, 8, 0.16)), aluminium);
  gateway.position.y = 1.05;
  gateway.castShadow = true;
  gateway.receiveShadow = true;
  world.add(gateway);
  const cap = new Mesh(keep(new RoundedBoxGeometry(1.2, 0.08, 1.2, 4, 0.04)), keep(new MeshPhysicalMaterial({ color: "#1c2427", metalness: 0.8, roughness: 0.18, clearcoat: 1 })));
  cap.position.y = 2.12;
  world.add(cap);
  const bandMaterials = stageHeights.map(() => keep(new MeshStandardMaterial({ color: "#0c2226", emissive: palette.channel, emissiveIntensity: 0.9, roughness: 0.3 })));
  stageHeights.forEach((height, index) => {
    const band = new Mesh(keep(new RoundedBoxGeometry(1.6, 0.055, 1.6, 2, 0.02)), bandMaterials[index]);
    band.position.y = height;
    world.add(band);
  });

  // Bots: ceramic capsules on dark pedestals with a lit collar.
  const ceramic = keep(new MeshPhysicalMaterial({ color: palette.ceramic, roughness: 0.42, clearcoat: 0.8, clearcoatRoughness: 0.2, envMapIntensity: 0.6 }));
  const pedestalMaterial = keep(new MeshPhysicalMaterial({ color: "#2b3438", metalness: 0.9, roughness: 0.35 }));
  const collarMaterial = keep(new MeshStandardMaterial({ color: "#0c2226", emissive: palette.channel, emissiveIntensity: 1.4 }));
  const pedestalGeometry = keep(new CylinderGeometry(0.38, 0.42, 0.1, 40));
  const botGeometry = keep(new CapsuleGeometry(0.23, 0.36, 8, 24));
  const collarGeometry = keep(new TorusGeometry(0.25, 0.018, 12, 48));
  const visorGeometry = keep(new CylinderGeometry(0.236, 0.236, 0.13, 40, 1, true, -0.4, 2.2));
  const visorMaterial = keep(new MeshPhysicalMaterial({ color: "#0b1013", metalness: 0.4, roughness: 0.12, clearcoat: 1, side: DoubleSide }));
  for (const z of lanes) {
    const bot = new Group();
    bot.position.set(-3.5, 0, z);
    const pedestal = new Mesh(pedestalGeometry, pedestalMaterial);
    pedestal.position.y = 0.05;
    pedestal.receiveShadow = true;
    const body = new Mesh(botGeometry, ceramic);
    body.position.y = 0.52;
    body.castShadow = true;
    const collar = new Mesh(collarGeometry, collarMaterial);
    collar.rotation.x = Math.PI / 2;
    collar.position.y = 0.34;
    const visor = new Mesh(visorGeometry, visorMaterial);
    visor.position.y = 0.66;
    bot.add(pedestal, body, collar, visor);
    world.add(bot);
  }

  // Devices: three graphite enclosures of different proportions, each with a status light.
  const deviceMaterial = keep(new MeshPhysicalMaterial({ color: palette.device, metalness: 0.85, roughness: 0.38, clearcoat: 0.4 }));
  const ledMaterial = keep(new MeshStandardMaterial({ color: "#10301f", emissive: "#46c27d", emissiveIntensity: 2.2 }));
  const ledGeometry = keep(new SphereGeometry(0.035, 16, 12));
  const enclosures: Array<[number, number, number]> = [[1.15, 0.26, 0.82], [0.82, 0.86, 0.74], [0.78, 0.18, 0.78]];
  const ventGeometry = keep(new RoundedBoxGeometry(0.012, 0.035, 0.3, 1, 0.005));
  lanes.forEach((z, index) => {
    const [width, height, depth] = enclosures[index];
    const device = new Mesh(keep(new RoundedBoxGeometry(width, height, depth, 4, 0.06)), deviceMaterial);
    device.position.set(3.45, height / 2 + 0.01, z);
    for (let vent = 0; vent < Math.max(1, Math.floor(height / 0.12)); vent++) {
      const slit = new Mesh(ventGeometry, engraving);
      slit.position.set(3.45 - width / 2 - 0.004, 0.08 + vent * 0.11, z - depth / 2 + 0.24);
      world.add(slit);
    }
    device.castShadow = true;
    device.receiveShadow = true;
    world.add(device);
    const led = new Mesh(ledGeometry, ledMaterial);
    led.position.set(3.45 - width / 2 - 0.005, Math.min(height - 0.07, 0.1), z + depth / 2 - 0.12);
    world.add(led);
  });

  // Request pulses.
  const pulseGeometry = keep(new SphereGeometry(0.06, 20, 14));
  const pulses = routes.map((entry) => {
    const mesh = new Mesh(pulseGeometry, keep(new MeshStandardMaterial({ color: entry.color, emissive: entry.color, emissiveIntensity: 7 })));
    world.add(mesh);
    return mesh;
  });

  const camera = new PerspectiveCamera(28, 1, 0.1, 120);
  const target = new Vector3(-0.55, 0.45, 0.1);
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new Vector2(1, 1), 0.6, 0.45, 0.92);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  disposables.push(composer, bloom);

  let width = 1;
  let height = 1;
  const resize = (): void => {
    const box = host.getBoundingClientRect();
    width = Math.max(1, Math.round(box.width));
    height = Math.max(1, Math.round(box.height));
    renderer.setSize(width, height, false);
    composer.setSize(width, height);
    camera.aspect = width / height;
    frameView();
    camera.updateProjectionMatrix();
  };

  // Fit the plate's bounding sphere whatever the panel's aspect, then shift the
  // view so the unit sits above the headline in the lower part of the panel.
  const pointer = new Vector2();
  const eased = new Vector2();
  const radius = 5.1;
  const place = (time: number): void => {
    eased.lerp(pointer, still ? 1 : 0.04);
    const vertical = (camera.fov * Math.PI) / 360;
    const horizontal = Math.atan(Math.tan(vertical) * camera.aspect);
    const distance = radius / Math.sin(Math.min(vertical, horizontal));
    const azimuth = -0.5 + (still ? 0 : Math.sin(time * 0.00009) * 0.09) + eased.x * 0.1;
    const elevation = 0.46 - eased.y * 0.05;
    camera.position.set(
      target.x + Math.sin(azimuth) * Math.cos(elevation) * distance,
      target.y + Math.sin(elevation) * distance,
      target.z + Math.cos(azimuth) * Math.cos(elevation) * distance,
    );
    camera.lookAt(target);
    const fog = scene.fog as Fog;
    fog.near = distance - 2;
    fog.far = distance + 12;
  };
  const frameView = (): void => {
    // Tall panels have room above the text; lift the scene into it.
    // Banner-shaped panels (phones) put the headline over the lower half.
    const lift = camera.aspect > 1.6 ? 0.16 : camera.aspect < 1.2 ? 0.1 : 0.04;
    camera.setViewOffset(width, height, 0, height * lift, width, height);
  };

  const flashes = [0, 0, 0];
  const frame = (time: number): void => {
    const seconds = time / 1000;
    flashes.fill(0);
    routes.forEach((entry, index) => {
      const t = still ? (entry.offset + 0.15) % 1 : (seconds * entry.speed + entry.offset) % 1;
      const point = curves[index].getPointAt(t);
      const inside = Math.abs(point.x) < gatewayHalf - 0.05;
      pulses[index].visible = !inside;
      pulses[index].position.copy(point).setY(0.07);
      // Light the stage band while the request is inside the unit.
      const centre = 1 - Math.min(1, Math.abs(point.x) / gatewayHalf);
      if (inside) flashes[entry.stage] = Math.max(flashes[entry.stage], centre);
    });
    bandMaterials.forEach((material, index) => { material.emissiveIntensity = 0.9 + flashes[index] * 3.2; });
    place(time);
    composer.render();
  };

  let running = false;
  let visible = true;
  let handle = 0;
  const loop = (time: number): void => {
    frame(time);
    handle = requestAnimationFrame(loop);
  };
  const update = (): void => {
    const should = !still && visible && document.visibilityState === "visible";
    if (should && !running) { running = true; handle = requestAnimationFrame(loop); }
    if (!should && running) { running = false; cancelAnimationFrame(handle); }
  };
  const observer = new ResizeObserver(() => { resize(); if (!running) frame(performance.now()); });
  observer.observe(host);
  const intersection = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; update(); });
  intersection.observe(host);
  const onVisibility = (): void => update();
  document.addEventListener("visibilitychange", onVisibility);
  const onPointer = (event: PointerEvent): void => {
    const box = host.getBoundingClientRect();
    pointer.set(((event.clientX - box.left) / box.width - 0.5) * 2, ((event.clientY - box.top) / box.height - 0.5) * 2);
  };
  if (!still) window.addEventListener("pointermove", onPointer, { passive: true });

  resize();
  frame(performance.now());
  update();

  return {
    dispose() {
      running = false;
      cancelAnimationFrame(handle);
      observer.disconnect();
      intersection.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pointermove", onPointer);
      for (const item of disposables) item.dispose();
      scene.traverse((object) => {
        const mesh = object as Mesh;
        if (mesh.isMesh) (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach((material: Material) => material.dispose());
      });
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
