/*
 * admDeathCauses — pure line-level classifier for DayZ ADM death lines.
 *
 * Feeds processAdmDeathCauses (routes/logParser.js), which streams ADM files
 * and persists one event per death to the events table (event type
 * 'player.death_cause') via the eventWriter pattern — same shape as the CE
 * dynamic events feed.
 *
 * Death lines observed (SALT XB, 2026-10):
 *   Player "V" (DEAD) (id=… pos=<…>) killed by Player "K" (id=… pos=<…>) with W from M meters
 *   Player "V" (DEAD) (id=… pos=<…>) killed by NO DRIVER (VehicleClass)
 *   Player "V" (DEAD) (id=… pos=<…>) killed by ZmbM_…            (single-token NPC class)
 *   Player "V" (id=… pos=<…>)        committed suicide           (no DEAD marker)
 *   Player "V" (DEAD) (id=… pos=<…>) bled out
 *   Player "V" (DEAD) (id=… pos=<…>) drowned. Stats> Water: … Energy: … Bleed sources: N
 *   Player "V" (DEAD) (id=… pos=<…>) died. Stats> Water: … Energy: … Bleed sources: N
 * Context lines (same player, earlier in the same file):
 *   …[HP: N] hit by FallDamageHealth                                  → fall attribution
 *   …[HP: N] hit by Player "K" (id=…) into BodyPart(N) for D damage (Ammo) with W → kill body part
 */

'use strict';

const FALL_ATTRIBUTION_MS = 5000; // shortcut: same-file 0–5s fall-hit window; widen if spot-checks drift

// HH:MM:SS | Player "Name" [(DEAD)] (id=HEX [pos=<x, y, z>])
const HEAD = /^(\d{2}:\d{2}:\d{2}) \| Player "([^"]+)"(?: \(DEAD\))? \(id=([A-Za-z0-9_-]+={0,2})(?: pos=<(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+)>)?\)/;

function saneCoord(v) {
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) < 1000000 ? n : null;
}

/**
 * Classify one ADM line. Returns null when the line is not a death line.
 * @returns {null|{time, victimName, victimId, pos:[number,number,number]|null, cause, killerName?, killerId?, weapon?, distance?, vehicle?, npcClass?}}
 * cause: 'pvp' | 'infected' | 'npc' | 'vehicle' | 'suicide' | 'bleed' | 'drowned' | 'unknown'
 * ('unknown' is a 'died. Stats>' line the caller may re-classify as 'fall').
 */
function classifyAdmDeathLine(line) {
  const head = HEAD.exec(line);
  if (!head) return null;
  const tail = line.slice(head[0].length).trim();

  let attrs;
  let m = tail.match(/^killed by Player "([^"]+)" \(id=([A-Za-z0-9_-]+={0,2})(?: pos=<[^>]*>)?\) with (.+?)(?: from ([\d.]+) meters)?$/);
  if (m) {
    attrs = { cause: 'pvp', killerName: m[1], killerId: m[2], weapon: m[3], distance: m[4] ? parseFloat(m[4]) : null };
  } else if ((m = tail.match(/^killed by NO DRIVER \(([^)]+)\)$/))) {
    attrs = { cause: 'vehicle', vehicle: m[1] };
  } else if ((m = tail.match(/^killed by (\S+)$/))) {
    attrs = { cause: m[1].startsWith('Zmb') ? 'infected' : 'npc', npcClass: m[1] };
  } else if (tail === 'committed suicide') {
    attrs = { cause: 'suicide' };
  } else if (tail === 'bled out') {
    attrs = { cause: 'bleed' };
  } else if (tail.startsWith('drowned. Stats>')) {
    attrs = { cause: 'drowned' };
  } else if (tail.startsWith('died. Stats>')) {
    attrs = { cause: 'unknown' };
  } else {
    return null;
  }

  const x = saneCoord(head[4]);
  const y = saneCoord(head[5]);
  const z = saneCoord(head[6]);
  return {
    time: head[1],
    victimName: head[2],
    victimId: head[3],
    pos: head[4] !== undefined && x !== null && y !== null && z !== null ? [x, y, z] : null,
    ...attrs,
  };
}

/**
 * Classify one ADM line as damage context. Returns null when it is not a
 * usable hit line. @returns {null|{kind:'fall', ms, playerId}|{kind:'pvp_hit', ms, victimId, attackerId, bodyPart}}
 */
function classifyAdmHitLine(line, ms) {
  if (ms == null) return null;
  let m = line.match(/^(\d{2}:\d{2}:\d{2}) \| Player "([^"]+)" \(id=([A-Za-z0-9_-]+={0,2}) pos=<[^>]*>\)\[HP: [\d.]+\] hit by FallDamageHealth\b/);
  if (m) return { kind: 'fall', ms, playerId: m[3] };
  m = line.match(/^(\d{2}:\d{2}:\d{2}) \| Player "([^"]+)" \(id=([A-Za-z0-9_-]+={0,2}) pos=<[^>]*>\)\[HP: [\d.]+\] hit by Player "([^"]+)" \(id=([A-Za-z0-9_-]+={0,2})(?: pos=<[^>]*>)?\)(?: into ([A-Za-z]+)\(\d+\))? for [\d.]+ damage \(\S+\)(?: with .+?)?\s*$/);
  if (m) return { kind: 'pvp_hit', ms, victimId: m[3], attackerId: m[5], bodyPart: m[6] || null };
  return null;
}

module.exports = {
  classifyAdmDeathLine,
  classifyAdmHitLine,
  FALL_ATTRIBUTION_MS,
};
