/**
 * Geometry3DView — a Three.js/WebGL renderer for the {@link GeometryScene}.
 *
 * Given a pure {@link GeometryScene} (built by {@link ./geometry3d}.buildGeometryScene),
 * this mounts a `WebGLRenderer` with a `PerspectiveCamera`, ambient + directional
 * lighting, a ground `GridHelper` + `AxesHelper`, and one `Mesh` per
 * {@link GeometryItem} (Box/Sphere/Cylinder) placed at its position/size/colour.
 * The camera is framed to the scene bounds. Orbit + zoom are provided by
 * `OrbitControls`; clicking a mesh raycasts to the backing element and reports it
 * through `onSelect`, highlighting the picked mesh. Auto-rotate is suppressed when
 * the user prefers reduced motion.
 *
 * Robustness: WebGL context creation is guarded — if it fails (headless without a
 * GPU, a locked-down browser, or jsdom), the component renders a graceful
 * "WebGL unavailable" fallback instead of throwing. The renderer, geometries, and
 * materials are disposed on unmount, and the view is resize-aware.
 *
 * NOTE: this component is validated by Playwright E2E (headless Chromium has a
 * real WebGL context); it is intentionally NOT mounted in jsdom unit tests, which
 * cannot provide a WebGL context.
 */

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { GeometryItem, GeometryScene } from './geometry3d';

export interface Geometry3DViewProps {
  /** The pure scene to render. */
  scene: GeometryScene;
  /** Reports the element id backing a clicked mesh (or `null` when clicking empty space). */
  onSelect?: (elementId: string | null) => void;
}

/** Build a Three.js geometry primitive for an item's shape + size. */
function makeGeometry(item: GeometryItem): THREE.BufferGeometry {
  const { x, y, z } = item.size;
  switch (item.shape) {
    case 'sphere':
      // Use the largest half-extent as radius so it fills the item's box.
      return new THREE.SphereGeometry(Math.max(x, y, z) / 2, 32, 24);
    case 'cylinder':
      return new THREE.CylinderGeometry(Math.max(x, z) / 2, Math.max(x, z) / 2, y, 32);
    case 'box':
    default:
      return new THREE.BoxGeometry(x, y, z);
  }
}

/** True when the user has asked the platform to minimise motion. */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function Geometry3DView({ scene, onSelect }: Geometry3DViewProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [webglFailed, setWebglFailed] = useState(false);
  // Keep the latest onSelect without re-running the heavy setup effect.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // ── Guarded renderer creation ────────────────────────────────────────
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
      // Some environments construct the renderer but have no usable context.
      if (!renderer.getContext()) throw new Error('no WebGL context');
    } catch (err) {
      console.warn('Geometry3DView: WebGL unavailable, rendering fallback', err);
      setWebglFailed(true);
      return;
    }

    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height, false);
    renderer.setClearColor(0x1b1f26, 1);
    const canvas = renderer.domElement;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    container.appendChild(canvas);

    const threeScene = new THREE.Scene();

    // ── Camera framed to the scene bounds ────────────────────────────────
    const { bounds } = scene;
    const span = Math.max(bounds.size.x, bounds.size.y, bounds.size.z, 1);
    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, span * 100 + 1000);
    const dist = span * 2.2 + 6;
    camera.position.set(
      bounds.center.x + dist,
      bounds.center.y + dist * 0.8,
      bounds.center.z + dist,
    );
    camera.lookAt(bounds.center.x, bounds.center.y, bounds.center.z);

    // ── Lights ────────────────────────────────────────────────────────────
    threeScene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const dir = new THREE.DirectionalLight(0xffffff, 0.9);
    dir.position.set(1, 2, 1.5);
    threeScene.add(dir);

    // ── Ground helpers ────────────────────────────────────────────────────
    const gridSize = Math.max(span * 4, 20);
    const grid = new THREE.GridHelper(gridSize, 20, 0x555b66, 0x33383f);
    grid.position.set(bounds.center.x, bounds.min.y, bounds.center.z);
    threeScene.add(grid);
    threeScene.add(new THREE.AxesHelper(Math.max(span, 3)));

    // ── One mesh per item ────────────────────────────────────────────────
    const meshes: THREE.Mesh[] = [];
    const geometries: THREE.BufferGeometry[] = [];
    const materials: THREE.Material[] = [];
    for (const item of scene.items) {
      const geom = makeGeometry(item);
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(item.color),
        roughness: 0.6,
        metalness: 0.1,
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.set(item.position.x, item.position.y, item.position.z);
      mesh.userData.elementId = item.elementId;
      threeScene.add(mesh);
      meshes.push(mesh);
      geometries.push(geom);
      materials.push(mat);
    }

    // ── Orbit controls (auto-rotate unless reduced motion) ───────────────
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.target.set(bounds.center.x, bounds.center.y, bounds.center.z);
    controls.autoRotate = !prefersReducedMotion() && scene.items.length > 0;
    controls.autoRotateSpeed = 0.6;
    controls.update();

    // ── Click → raycast → onSelect + highlight ───────────────────────────
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let highlighted: THREE.Mesh | null = null;
    const emissiveOf = new WeakMap<THREE.Mesh, number>();

    const setHighlight = (mesh: THREE.Mesh | null): void => {
      if (highlighted && highlighted !== mesh) {
        const mat = highlighted.material as THREE.MeshStandardMaterial;
        mat.emissive.setHex(emissiveOf.get(highlighted) ?? 0x000000);
      }
      if (mesh) {
        const mat = mesh.material as THREE.MeshStandardMaterial;
        if (!emissiveOf.has(mesh)) emissiveOf.set(mesh, mat.emissive.getHex());
        mat.emissive.setHex(0x3a6ea5);
      }
      highlighted = mesh;
    };

    // Distinguish a click from an orbit-drag: only select on a near-stationary press.
    let downX = 0;
    let downY = 0;
    const onPointerDown = (ev: PointerEvent): void => {
      downX = ev.clientX;
      downY = ev.clientY;
    };
    const onPointerUp = (ev: PointerEvent): void => {
      if (Math.hypot(ev.clientX - downX, ev.clientY - downY) > 5) return;
      const rect = canvas.getBoundingClientRect();
      pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(meshes, false)[0];
      if (hit) {
        const mesh = hit.object as THREE.Mesh;
        setHighlight(mesh);
        onSelectRef.current?.((mesh.userData.elementId as string) ?? null);
      } else {
        setHighlight(null);
        onSelectRef.current?.(null);
      }
    };
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointerup', onPointerUp);

    // ── Render loop ──────────────────────────────────────────────────────
    let raf = 0;
    const animate = (): void => {
      raf = requestAnimationFrame(animate);
      controls.update();
      renderer.render(threeScene, camera);
    };
    animate();

    // ── Resize-aware ─────────────────────────────────────────────────────
    const resize = (): void => {
      const w = Math.max(1, container.clientWidth);
      const h = Math.max(1, container.clientHeight);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    };
    const ro =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => resize()) : undefined;
    ro?.observe(container);
    window.addEventListener('resize', resize);

    // ── Cleanup ──────────────────────────────────────────────────────────
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      ro?.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
      controls.dispose();
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      renderer.dispose();
      if (canvas.parentNode === container) container.removeChild(canvas);
    };
    // Rebuild the scene whenever the projection changes.
  }, [scene]);

  if (webglFailed) {
    return (
      <div
        data-testid="geometry-3d"
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#c7ccd4',
          background: '#1b1f26',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <div style={{ textAlign: 'center', padding: 24 }}>
          <div style={{ fontSize: 18, marginBottom: 8 }}>3D geometry view</div>
          <div style={{ opacity: 0.75 }}>WebGL unavailable in this environment.</div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      data-testid="geometry-3d"
      style={{ width: '100%', height: '100%', overflow: 'hidden', background: '#1b1f26' }}
    />
  );
}

export default Geometry3DView;
