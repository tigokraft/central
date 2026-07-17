// Owns the "live" canvas viewport outside of React so pan/zoom can update the transformed
// DOM node every animation frame without going through a store set()/re-render per tick.
// InfiniteCanvas attaches its transform + grid DOM nodes on mount; the zustand store (see
// canvasStore.ts) mirrors this controller's settled value on a trailing debounce so
// dependent UI (Minimap, zoom% readouts) stays roughly in sync without subscribing to every
// intermediate frame.

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export const MIN_ZOOM = 0.15;
export const MAX_ZOOM = 4;
export const GRID_GAP = 16;

const COMMIT_DEBOUNCE_MS = 120;
const LIVE_THROTTLE_MS = 120;
const EASE_DURATION_MS = 280;
const MOMENTUM_FRICTION = 0.94; // per ~16.7ms frame
const MOMENTUM_STOP_THRESHOLD = 0.03; // px/frame

export function clampZoom(zoom: number): number {
  return Math.min(Math.max(zoom, MIN_ZOOM), MAX_ZOOM);
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export function computeTransformStyle(vp: Viewport): string {
  return `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`;
}

export function computeGridStyle(vp: Viewport): { backgroundSize: string; backgroundPosition: string } {
  const scaledGap = GRID_GAP * vp.zoom;
  return {
    backgroundSize: `${scaledGap}px ${scaledGap}px`,
    backgroundPosition: `${vp.x % scaledGap}px ${vp.y % scaledGap}px`,
  };
}

class ViewportController {
  private vp: Viewport = { x: 0, y: 0, zoom: 1 };
  private transformEl: HTMLDivElement | null = null;
  private gridEl: HTMLDivElement | null = null;

  private rafId: number | null = null;
  private commitTimer: number | null = null;
  private commit: ((vp: Viewport) => void) | null = null;

  private liveListeners = new Set<(vp: Viewport) => void>();
  private lastLiveNotify = 0;

  // Bumped on every user-initiated mutation so an in-flight momentum/eased animation can
  // detect it has been superseded and stop mutating `vp` on its next frame.
  private animGen = 0;
  private momentum: { vx: number; vy: number } | null = null;

  init(initial: Viewport, commit: (vp: Viewport) => void) {
    this.vp = initial;
    this.commit = commit;
  }

  attachDom(transformEl: HTMLDivElement | null, gridEl: HTMLDivElement | null) {
    this.transformEl = transformEl;
    this.gridEl = gridEl;
    this.applyImmediate();
  }

  detachDom() {
    this.transformEl = null;
    this.gridEl = null;
  }

  getViewport(): Viewport {
    return this.vp;
  }

  subscribeLive(fn: (vp: Viewport) => void): () => void {
    this.liveListeners.add(fn);
    fn(this.vp);
    return () => {
      this.liveListeners.delete(fn);
    };
  }

  private applyImmediate() {
    if (this.transformEl) {
      this.transformEl.style.transform = computeTransformStyle(this.vp);
    }
    if (this.gridEl) {
      const { backgroundSize, backgroundPosition } = computeGridStyle(this.vp);
      this.gridEl.style.backgroundSize = backgroundSize;
      this.gridEl.style.backgroundPosition = backgroundPosition;
    }
    this.notifyLive(false);
  }

  private notifyLive(force: boolean) {
    const now = performance.now();
    if (!force && now - this.lastLiveNotify < LIVE_THROTTLE_MS) return;
    this.lastLiveNotify = now;
    this.liveListeners.forEach((fn) => fn(this.vp));
  }

  private scheduleFrame() {
    if (this.rafId != null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.applyImmediate();
    });
  }

  private scheduleCommit() {
    if (this.commitTimer != null) window.clearTimeout(this.commitTimer);
    this.commitTimer = window.setTimeout(() => {
      this.commitTimer = null;
      this.commit?.(this.vp);
    }, COMMIT_DEBOUNCE_MS);
  }

  // Cancels any in-flight momentum/eased-zoom animation so a fresh user gesture always wins.
  private cancelAnimation() {
    this.animGen++;
    this.momentum = null;
  }

  private setRaw(next: Partial<Viewport>) {
    this.vp = { ...this.vp, ...next };
    this.scheduleFrame();
    this.scheduleCommit();
  }

  /** Instant, 1:1 pan — used by wheel/trackpad and manual middle-click drag. */
  panBy(dx: number, dy: number) {
    this.cancelAnimation();
    this.setRaw({ x: this.vp.x + dx, y: this.vp.y + dy });
  }

  /**
   * Instant, 1:1 zoom anchored on (focalX, focalY) in container-local px — used by
   * ctrl+wheel/pinch so the zoom tracks the cursor/fingers directly, no easing.
   */
  zoomBy(factor: number, focalX: number, focalY: number) {
    this.cancelAnimation();
    const zoom = clampZoom(this.vp.zoom * factor);
    const dx = focalX - this.vp.x;
    const dy = focalY - this.vp.y;
    this.setRaw({
      zoom,
      x: focalX - dx * (zoom / this.vp.zoom),
      y: focalY - dy * (zoom / this.vp.zoom),
    });
  }

  /** Instant, no anchor — used when there's no meaningful focal point. */
  setInstant(vp: Viewport) {
    this.cancelAnimation();
    this.vp = vp;
    this.scheduleFrame();
    this.scheduleCommit();
  }

  /** Eased lerp to a target viewport — used by zoom buttons, zoomToFit, Shift+1/Shift+2. */
  animateTo(target: Viewport, duration = EASE_DURATION_MS) {
    this.cancelAnimation();
    const gen = this.animGen;
    const start = { ...this.vp };
    const startTime = performance.now();

    const step = (now: number) => {
      if (gen !== this.animGen) return; // superseded by a newer gesture
      const t = Math.min((now - startTime) / duration, 1);
      const eased = easeOutCubic(t);
      this.vp = {
        x: start.x + (target.x - start.x) * eased,
        y: start.y + (target.y - start.y) * eased,
        zoom: start.zoom + (target.zoom - start.zoom) * eased,
      };
      this.applyImmediate();
      this.scheduleCommit();
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /** Starts RAF-driven friction decay from an initial velocity, in px/frame (~16.7ms). */
  startMomentum(vx: number, vy: number) {
    if (Math.hypot(vx, vy) < MOMENTUM_STOP_THRESHOLD) return;
    this.cancelAnimation();
    const gen = this.animGen;
    this.momentum = { vx, vy };
    let lastTime = performance.now();

    const step = (now: number) => {
      if (gen !== this.animGen || !this.momentum) return;
      const dtFrames = Math.min((now - lastTime) / (1000 / 60), 4);
      lastTime = now;

      this.momentum.vx *= Math.pow(MOMENTUM_FRICTION, dtFrames);
      this.momentum.vy *= Math.pow(MOMENTUM_FRICTION, dtFrames);
      this.vp = {
        ...this.vp,
        x: this.vp.x + this.momentum.vx * dtFrames,
        y: this.vp.y + this.momentum.vy * dtFrames,
      };
      this.applyImmediate();
      this.scheduleCommit();

      if (Math.hypot(this.momentum.vx, this.momentum.vy) < MOMENTUM_STOP_THRESHOLD) {
        this.momentum = null;
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}

export const viewportController = new ViewportController();
