/* global window */
/* Holiday event windows (roadmap P1). Config lives in /data/holiday-windows.json;
   edit dates there, no code changes. Windows are inclusive calendar days in the
   viewer's local timezone — shortcut: per-browser TZ; switch to ISO instants if
   windows must follow one specific server timezone. */
window.HolidayWindows = {
  config: null,

  async load() {
    if (this.config) return this.config;
    const res = await fetch('/data/holiday-windows.json');
    if (!res.ok) throw new Error('Failed to load holiday windows config: ' + res.status);
    this.config = await res.json();
    return this.config;
  },

  /* Pure: which holiday owns this mission folder, and is its window open now?
     Returns { id, label, icon, live, start, end, windows } or null (not a holiday mission).
     missionName is a mission folder like "ChristmasOffline.ChernarusPlus" (prefix-matched, case-insensitive). */
  matchState(events, missionName, now) {
    if (!missionName) return null;
    const t = now ? now.getTime() : Date.now();
    const lower = String(missionName).toLowerCase();
    for (const ev of events || []) {
      const hit = (ev.missions || []).some(m => lower.startsWith(String(m).toLowerCase()));
      if (!hit) continue;
      let live = false;
      let start = null;
      let end = null;
      for (const win of ev.windows || []) {
        if (!Array.isArray(win) || win.length !== 2) continue;
        const ws = this.dayStartLocal(win[0]);
        const we = this.dayEndLocal(win[1]);
        if (ws <= t && t <= we) { live = true; start = win[0]; end = win[1]; break; }
      }
      return { id: ev.id, label: ev.label, icon: ev.icon || '📅', live: live, start: start, end: end, windows: ev.windows || [] };
    }
    return null;
  },

  dayStartLocal(yyyymmdd) {
    const p = String(yyyymmdd).split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 0, 0, 0, 0).getTime();
  },

  dayEndLocal(yyyymmdd) {
    const p = String(yyyymmdd).split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 23, 59, 59, 999).getTime();
  },
};
