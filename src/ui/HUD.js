/**
 * HUD.js — minimalist translucent instrument cluster.
 *
 * Pure HTML/CSS overlay (no canvas text): crisp at any DPI, zero render
 * cost, easy to restyle. Fields that need the boat (SOG, AWA, sail angle)
 * show "—" until Phase 2/3 wire them up via update().
 */

export class HUD {
  constructor(parent = document.body) {
    this.root = document.createElement('div');
    this.root.id = 'hud';
    this.root.innerHTML = `
      <div class="hud-row hud-title">⛵ SAILBOAT SIM <span class="hud-phase">phase 1 — ocean &amp; wind</span></div>
      <div class="hud-grid">
        <div class="hud-cell"><label>TWS</label><output data-f="tws">—</output><small>kn</small></div>
        <div class="hud-cell"><label>TWD</label><output data-f="twd">—</output><small>°</small></div>
        <div class="hud-cell"><label>SOG</label><output data-f="sog">—</output><small>kn</small></div>
        <div class="hud-cell"><label>HDG</label><output data-f="hdg">—</output><small>°</small></div>
        <div class="hud-cell"><label>HEEL</label><output data-f="heel">—</output><small>°</small></div>
        <div class="hud-cell"><label>AWA</label><output data-f="awa">—</output><small>°</small></div>
        <div class="hud-cell"><label>SAIL</label><output data-f="sail">—</output><small>°</small></div>
      </div>
      <div class="hud-compass">
        <span class="hud-compass-n">N</span>
        <span class="hud-wind-arrow" title="wind blows this way">➤</span>
      </div>
      <div class="hud-help">←/→ helm &nbsp; ↑/↓ sheet &nbsp; T auto-trim &nbsp; R reset</div>`;
    parent.appendChild(this.root);

    // Cache field references once — update() runs every frame.
    this._fields = {};
    for (const el of this.root.querySelectorAll('output[data-f]')) {
      this._fields[el.dataset.f] = el;
    }
    this._arrow = this.root.querySelector('.hud-wind-arrow');
  }

  /**
   * @param {object} d any subset of:
   *   tws (knots), twd (deg FROM), sog (knots), hdg (deg), heel (deg),
   *   awa (deg), sail (deg). Omitted/null fields keep their display.
   */
  update(d) {
    if (d.tws != null) this._fields.tws.textContent = d.tws.toFixed(1);
    if (d.twd != null) {
      this._fields.twd.textContent = Math.round(d.twd).toString().padStart(3, '0');
      // Arrow shows where the wind is blowing TOWARDS on a north-up compass.
      // The glyph ➤ points right (east) at 0 rotation, hence the -90 offset.
      this._arrow.style.transform = `rotate(${d.twd + 180 - 90}deg)`;
    }
    if (d.sog != null) this._fields.sog.textContent = d.sog.toFixed(1);
    if (d.hdg != null) this._fields.hdg.textContent = Math.round(d.hdg).toString().padStart(3, '0');
    if (d.heel != null) this._fields.heel.textContent = d.heel.toFixed(0);
    if (d.awa != null) this._fields.awa.textContent = Math.round(d.awa).toString();
    if (d.sail != null) this._fields.sail.textContent = Math.round(d.sail).toString();
  }
}
