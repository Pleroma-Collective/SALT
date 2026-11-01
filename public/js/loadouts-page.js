    // [slug, display name, tier] — holiday-first ordering per roadmap P1.
    const LOADOUTS = [
      // Holiday
      ['loadoutsanta', 'Loadout Santa', 'holiday'],
      ['loadoutspook', 'Loadout Spook', 'holiday'],
      ['loadoutpumpkin', 'Loadout Pumpkin', 'holiday'],
      ['loadoutvanillaenhancedwalpurgisnite', 'Vanilla+ Walpurgis Night', 'holiday'],
      ['loadoutvanillaenhancedxmas', 'Vanilla+ Christmas', 'holiday'],
      ['loadoutdedmoroz', 'Loadout Ded Moroz', 'holiday'],
      ['loadoutcupid', 'Loadout Cupid', 'holiday'],
      // Themed
      ['loadoutpaydaychains', 'Payday — Chains', 'themed'],
      ['loadoutpaydaydallas', 'Payday — Dallas', 'themed'],
      ['loadoutpaydayhoxton', 'Payday — Hoxton', 'themed'],
      ['loadoutpaydaywolf', 'Payday — Wolf', 'themed'],
      ['loadoutnbcgray', 'NBC Gray', 'themed'],
      ['loadoutnbcwhite', 'NBC White', 'themed'],
      ['loadoutnbcyellow', 'NBC Yellow', 'themed'],
      ['loadoutmilitarybdu', 'Military — BDU', 'themed'],
      ['loadoutmilitarytsko', 'Military — TSKO', 'themed'],
      ['loadoutmilitaryusmcdesert', 'Military — USMC Desert', 'themed'],
      ['loadoutmilitaryusmcwoodland', 'Military — USMC Woodland', 'themed'],
      // Vanilla enhanced
      ['loadoutvanillaenhanced', 'Vanilla Enhanced', 'vanillaplus'],
      ['loadoutvanillaenhanced10thanniversary', 'Vanilla+ 10th Anniversary', 'vanillaplus'],
      // Remaining (alphabetical)
      ['loadoutbushlatpolice', 'Bush Lát Police', 'other'],
      ['loadoutbussy', 'Loadout Bussy', 'other'],
      ['loadoutcannibal', 'Loadout Cannibal', 'other'],
      ['loadoutcriminal', 'Loadout Criminal', 'other'],
      ['loadoutfirefighter', 'Loadout Firefighter', 'other'],
      ['loadoutghilliesuitwinter', 'Ghillie Suit — Winter', 'other'],
      ['loadoutghilliesuitwoodland', 'Ghillie Suit — Woodland', 'other'],
      ['loadouthannah', 'Loadout Hannah', 'other'],
      ['loadouthockey', 'Loadout Hockey', 'other'],
      ['loadoutknight', 'Loadout Knight', 'other'],
      ['loadoutlonestar', 'Loadout Lone Star', 'other'],
      ['loadoutnavy', 'Loadout Navy', 'other'],
      ['loadoutnavyomk', 'Loadout Navy OMK', 'other'],
      ['loadoutpoliceofficer', 'Loadout Police Officer', 'other'],
      ['loadoutpoliceswat', 'Loadout Police SWAT', 'other'],
      ['loadoutsakhal', 'Loadout Sakhal', 'other'],
      ['loadoutvegan', 'Loadout Vegan', 'other'],
      ['loadoutvodka', 'Loadout Vodka', 'other'],
      ['loadoutwarlock', 'Loadout Warlock', 'other'],
      ['loadoutwitch', 'Loadout Witch', 'other'],
      ['loadoutwolfman', 'Loadout Wolfman', 'other'],
      ['loadoutyellowking', 'Loadout Yellow King', 'other']
    ];

    const TIER_LABELS = { holiday: '🎄 Holiday', themed: '🎬 Themed', vanillaplus: '✨ Vanilla+', other: '🎒 Misc' };

    // Item stats for the cards: join loadout item types against the item
    // catalog (vanilla cfg stats live in items.json via the extractor).
    // shortcut: nasdara is only the fetch vehicle — the vanilla stats are
    // map-independent; upgrade to a map param if per-map stats ever diverge.
    let itemStats = null;
    async function ensureStats() {
      if (itemStats) return itemStats;
      const res = await fetch('/data/nasdara/items.json');
      if (!res.ok) throw new Error('items.json: HTTP ' + res.status);
      const doc = await res.json();
      const map = {};
      for (const it of doc.items || []) map[it.classname] = it;
      return (itemStats = map);
    }

    function escapeHtml(v) {
      return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // Unique item types across slots, named container groups (+ their contents), and loose items.
    function itemsOf(d) {
      const items = [];
      const groups = {};
      const seen = new Set();
      const add = (it, group) => {
        if (!it) return;
        if (!seen.has(it)) { seen.add(it); items.push(it); }
        if (group && it) (groups[group] = groups[group] || []).push(it);
      };
      (d.attachmentSlotItemSets || []).forEach(slot =>
        (slot.discreteItemSets || []).forEach(item => add(item.itemType)));
      (d.discreteUnsortedItemSets || []).forEach(group => {
        if (group.name) add(group.name, null);
        (group.complexChildrenTypes || []).forEach(item => add(item.itemType, group.name));
      });
      (d.simpleChildrenTypes || []).forEach(it => add(it));
      return { items, groups };
    }

    async function copySpawnConfig(text, btn) {
      try {
        await navigator.clipboard.writeText(text);
      } catch (err) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      btn.textContent = '✓ Copied';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = 'Copy spawn config'; btn.classList.remove('copied'); }, 1500);
    }

    async function loadLoadouts() {
      const content = document.getElementById('loadout-content');
      // A failed refresh must keep stale cards visible (DataFreshness
      // contract) — capture before the spinner replaces them.
      const stale = content.querySelector('.card') ? content.innerHTML : null;
      content.innerHTML = '<div class="dzc-empty" data-dzc-loading><span class="dzc-spinner" role="status" aria-label="Loading"></span><div class="dzc-empty-title">Loading loadouts…</div></div>';
      // Catalog join is best-effort: if it fails, cards still render, just
      // without per-item stats.
      let stats = {};
      try { stats = await ensureStats(); } catch (err) { /* stats stay empty */ }
      let ok = 0;
      for (const tier of ['holiday', 'themed', 'vanillaplus', 'other']) {
        const slugs = LOADOUTS.filter(l => l[2] === tier);
        if (!slugs.length) continue;
        content.insertAdjacentHTML('beforeend', '<h2 class="tier-heading">' + TIER_LABELS[tier] + '</h2><div class="grid"></div>');
        const grid = content.lastElementChild;
        await Promise.all(slugs.map(async ([slug, name, tierTier]) => {
          const card = document.createElement('div');
          card.className = 'card';
          let body = '<div class="card-head"><h3>' + escapeHtml(name) + '</h3>' +
            '<span class="tier-badge t-' + tierTier + '">' + TIER_LABELS[tierTier] + '</span></div>';
          try {
            const res = await fetch('/kitty_loadouts/' + slug + '.json');
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const text = await res.text();
            const d = JSON.parse(text);
            const { items, groups } = itemsOf(d);
            ok++;
            const charTypes = (d.characterTypes || []).filter(Boolean);
            if (charTypes.length) body += '<div class="char-type">Character: ' + escapeHtml(charTypes.join(', ')) + '</div>';
            // All interpolated JSON fields pass through escapeHtml above (static page, own data).
            body += '<div class="item-list">';
            const renderName = it => groups[it]
              ? '<span class="group">' + escapeHtml(it) + '</span> (' + groups[it].map(escapeHtml).join(', ') + ')'
              : escapeHtml(it);
            const statsLine = it => {
              const st = stats[it];
              if (!st) return '';
              const bits = [];
              if (st.unique) bits.push('Unique');
              else if (st.tier) bits.push('Tier ' + st.tier);
              if (st.storageSlots != null) bits.push(st.storageSlots + (st.storageGrid ? ' (' + st.storageGrid + ')' : '') + ' slots');
              if (st.insulation != null) bits.push('insulation ' + st.insulation);
              return bits.length ? '<span class="item-stats">' + escapeHtml(bits.join(' · ')) + '</span>' : '';
            };
            items.forEach(it => {
              body += renderName(it) + statsLine(it) + '<br>';
              const st = stats[it];
              if (st && st.description) body += '<span class="item-desc">' + escapeHtml(st.description) + '</span><br>';
            });
            body += '</div>';
            body += '<div class="card-foot"><span class="item-count">' + items.length + ' items</span>' +
              '<button class="copy-btn" type="button">Copy spawn config</button></div>';
            card.innerHTML = body;
            card.querySelector('.copy-btn').addEventListener('click', e => copySpawnConfig(text, e.currentTarget));
          } catch (err) {
            body += '<div class="load-error">Failed to load: ' + escapeHtml(err.message) + '</div></div>';
            card.innerHTML = body;
          }
          grid.appendChild(card);
        }));
      }
      const failed = LOADOUTS.length - ok;
      const countEl = document.getElementById('loadout-count');
      if (ok === 0) {
        if (stale) { content.innerHTML = stale; return ok; } // keep stale cards; the freshness row shows the error
        countEl.textContent = '0 loadouts';
        content.innerHTML = '<div class="dzc-empty"><div class="dzc-empty-icon">📭</div><div class="dzc-empty-title">No loadout data yet</div>'
          + '<div style="margin-top:8px"><button type="button" class="dzc-btn is-primary" id="loadouts-retry">Retry</button></div></div>';
        // Route through dfh so a successful retry records the timestamp.
        document.getElementById('loadouts-retry').addEventListener('click', () => dfh ? dfh.run() : loadLoadouts());
      } else {
        const loading = content.querySelector('[data-dzc-loading]');
        if (loading) loading.remove();
        countEl.textContent = failed
          ? ok + '/' + LOADOUTS.length + ' loaded (' + failed + ' failed)'
          : LOADOUTS.length + ' loadouts';
      }
      return ok;
    }
    // Freshness indicator + Refresh (shared helper). ok === 0 throws so the
    // row surfaces the error; the empty-state Retry stays in the content.
    const dfh = window.DataFreshness
      ? DataFreshness.mount('loadouts-freshness', async () => {
          const ok = await loadLoadouts();
          if (ok === 0) throw new Error('Failed to load loadouts');
        })
      : null;
    if (!dfh) loadLoadouts();
