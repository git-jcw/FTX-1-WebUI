// Virtual VFO dial. Drag it round to tune: every 1/STEPS_PER_REV of a turn
// calls onStep(±n). A flick keeps it spinning for a moment, like a weighted
// knob; the mouse wheel and arrow keys give single steps.

export const STEPS_PER_REV = 60;
const STEP_DEG = 360 / STEPS_PER_REV;
const SPIN_MIN = 0.15;   // deg/ms at release needed to keep spinning
const SPIN_STOP = 0.02;  // deg/ms at which a spin ends
const SPIN_DECAY_MS = 350;

export class TuningDial {
  constructor(el, { onStep } = {}) {
    this.el = el; this.onStep = onStep;
    this.rotor = el.querySelector('.dial-rotor');
    this.angle = 0;   // how far the knob is turned, degrees
    this._carry = 0;  // rotation not yet paid out as steps
    this._vel = 0;    // deg/ms, smoothed while dragging
    this._spin = 0;   // bumped to cancel a running spin

    let last = null, lastT = 0;
    const angleAt = e => {
      const r = el.getBoundingClientRect();
      return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180 / Math.PI;
    };
    el.addEventListener('pointerdown', e => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      el.focus();
      this._spin++; this._vel = 0;
      last = angleAt(e); lastT = e.timeStamp;
    });
    el.addEventListener('pointermove', e => {
      if (last == null) return;
      const a = angleAt(e);
      const d = ((a - last + 540) % 360) - 180; // shortest way round
      const dt = e.timeStamp - lastT;
      if (dt > 0) this._vel = this._vel * 0.6 + (d / dt) * 0.4;
      last = a; lastT = e.timeStamp;
      this.turn(d);
    });
    const end = e => {
      if (last == null) return;
      last = null;
      // a pause before letting go means "stop here", not a flick
      if (e.type === 'pointerup' && e.timeStamp - lastT < 80 && Math.abs(this._vel) > SPIN_MIN) this._startSpin();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', e => { e.preventDefault(); this._spin++; this.nudge(e.deltaY < 0 ? 1 : -1); }, { passive: false });
    el.addEventListener('keydown', e => {
      const n = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 10, PageDown: -10 }[e.key];
      if (n) { e.preventDefault(); this._spin++; this.nudge(n); }
    });
  }

  // Turn the knob by d degrees (clockwise positive), paying out whole steps.
  turn(d) {
    this.angle += d; this._carry += d;
    const n = Math.trunc(this._carry / STEP_DEG);
    if (n) { this._carry -= n * STEP_DEG; this.onStep?.(n); }
    this._render();
  }

  // Exactly n steps.
  nudge(n) {
    this.angle += n * STEP_DEG;
    this.onStep?.(n);
    this._render();
  }

  _render() { if (this.rotor) this.rotor.style.transform = `rotate(${this.angle}deg)`; }

  _startSpin() {
    const token = ++this._spin;
    let t0 = performance.now();
    const tick = now => {
      if (token !== this._spin) return;
      const dt = Math.min(50, now - t0); t0 = now;
      this.turn(this._vel * dt);
      this._vel *= Math.exp(-dt / SPIN_DECAY_MS);
      if (Math.abs(this._vel) > SPIN_STOP) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}
