// ═══════════════════════════════════════════════════════════════
// AUDIT INJECTOR — UI in-page sur la page SharePoint
// ═══════════════════════════════════════════════════════════════
// Ce fichier s'auto-exécute quand il est injecté dans le contexte SP via le favori.
// Il attend que window.__AUDIT_CORE__ soit défini (concat avec le code audit côté start.py)
// puis :
//   1. Lance runAudit(document) → tague les vrais éléments SP avec data-audit-id
//   2. Dessine des pins numérotés sur chaque élément en erreur
//   3. Affiche un panneau latéral coulissant (Shadow DOM, isolé des styles SP)
//   4. Au survol d'un pin → tooltip avec le titre du problème
//   5. Au clic → l'issue passe en active dans le panneau
//   6. Le panneau a un bouton « Voir l'audit complet » qui ouvre la page audit standalone

(async function(){
  'use strict';
  if (window.__AUDIT_INJECTOR_LOADED__) {
    // Déjà injecté — toggle visibilité
    window.__AUDIT_INJECTOR_TOGGLE__ && window.__AUDIT_INJECTOR_TOGGLE__();
    return;
  }
  window.__AUDIT_INJECTOR_LOADED__ = true;

  const CORE = window.__AUDIT_CORE__;
  if (!CORE || !CORE.runAudit) {
    alert("❌ Le code d'audit n'est pas chargé. Vérifiez que start.py tourne et que le bundle est complet.");
    return;
  }

  // ═══ PERSISTANCE DES FLAGS (Marquer corrigé / Ignorer) PAR PAGE ════════
  // Stockage dans localStorage (domaine sharepoint.com). Clé = chemin de la page (pas le ?query).
  // À chaque audit (initial ou rerun), on ré-applique les flags stockés sur les findings matchants
  // par signature stable (message + element + context). Ainsi l'utilisateur ne perd jamais
  // son avancement sur une page, même après plusieurs jours.
  const FLAGS_KEY = 'a11y_flags_' + (location.pathname || '/');
  function loadStoredFlags() {
    try {
      const raw = localStorage.getItem(FLAGS_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch(_) { return {}; }
  }
  function saveStoredFlags(flags) {
    try { localStorage.setItem(FLAGS_KEY, JSON.stringify(flags)); } catch(_) {}
  }
  function issueSignature(i) {
    return (i.message || '') + '||' + (i.element || '') + '||' + (i.context || '');
  }
  function applyStoredFlagsToIssues(issuesArr) {
    const stored = loadStoredFlags();
    let n = 0;
    issuesArr.forEach(i => {
      const sig = issueSignature(i);
      const f = stored[sig];
      if (f) {
        if (f.fixed) { i._fixed = true; n++; }
        if (f.ignored) { i._ignored = true; n++; }
      }
    });
    if (n) console.log('[audit-injector] ' + n + ' flag(s) restauré(s) depuis localStorage');
    return n;
  }
  function persistFlagForIssue(i) {
    const stored = loadStoredFlags();
    const sig = issueSignature(i);
    if (i._fixed || i._ignored) {
      stored[sig] = {fixed: !!i._fixed, ignored: !!i._ignored};
    } else {
      delete stored[sig];
    }
    saveStoredFlags(stored);
  }
  function clearAllStoredFlagsForPage() {
    try { localStorage.removeItem(FLAGS_KEY); } catch(_) {}
  }

  // ═══ PRE-SCAN — réutilisable ════════════════════════════════════
  // Deux modes :
  //  - full : overlay bloquant + ouverture sections + scroll WebParts + scroll containers (~5-10s)
  //    Utilisé au 1er audit ET via le bouton « 🔍 Re-scan complet » (cas où l'agent a fait
  //    beaucoup de modifs SP entre temps, ou un nouveau WebPart vient d'être ajouté).
  //  - mini : juste ouvre les sections [aria-expanded=false] du canvas + petit délai (~1s)
  //    Utilisé via le bouton ↻ Relancer du header (cas courant : l'agent a corrigé un texte,
  //    il veut un re-check rapide sans bloquer).
  function selectorIsCollapsibleSection(b) {
    if (!b.closest('.SPCanvas-canvas,[data-sp-feature-tag],[data-automation-id="CanvasSection"]')) return false;
    if (b.closest('[data-automation-id="commandBar"],[data-automation-id="siteHeader"],.ms-CommandBar,.ms-Panel,.ms-Callout,[role="dialog"],[role="menu"],nav.topbar')) return false;
    return b.querySelector('h1,h2,h3,h4,h5,h6');
  }
  async function runMiniPreScan() {
    try {
      const togs = Array.from(document.querySelectorAll('[aria-expanded="false"]')).filter(selectorIsCollapsibleSection);
      if (togs.length) {
        togs.forEach(b => { try { b.click(); } catch(_) {} });
        await new Promise(r => setTimeout(r, 600));
      }
    } catch(e) { console.warn('[audit-injector] mini pre-scan error:', e); }
  }
  async function runFullPreScan() {
    const PSO = document.createElement('div');
    PSO.id = '__audit-prescan';
    PSO.style.cssText = 'all:initial;position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:2147483647;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif';
    PSO.innerHTML = `<div style="background:#fff;border-radius:12px;padding:32px;max-width:460px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.3);font-family:inherit"><h2 style="margin:0 0 8px;font-size:20px;font-weight:600;color:#222">🔍 Audit complet en cours</h2><p id="PSTP" style="margin:0 0 18px;color:#666;font-size:13px;line-height:1.5">Préparation...</p><div style="height:8px;background:#eee;border-radius:99px;overflow:hidden;margin-bottom:14px"><div id="PPRG" style="height:100%;background:linear-gradient(90deg,#1B873F,#3CA85F);width:0%;transition:width 0.3s"></div></div><p style="margin:0;color:#999;font-size:12px">⚠️ Ne fermez pas cet onglet et ne cliquez pas sur la page.</p></div>`;
    document.body.appendChild(PSO);
    const _bodyOv = document.body.style.overflow, _docOv = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    const STEP = (n, t, lbl, p) => {
      const stp = PSO.querySelector('#PSTP'), prg = PSO.querySelector('#PPRG');
      if (stp) stp.textContent = 'Étape ' + n + '/' + t + ' : ' + lbl;
      if (prg) prg.style.width = p + '%';
    };
    const cleanup = () => {
      PSO.remove();
      document.body.style.overflow = _bodyOv;
      document.documentElement.style.overflow = _docOv;
    };
    try {
      // Étape 1 : ouverture sections — délai d'attente réduit (400ms suffit pour la plupart)
      const togs = Array.from(document.querySelectorAll('[aria-expanded="false"]')).filter(selectorIsCollapsibleSection);
      STEP(1, 4, togs.length ? 'Ouverture de ' + togs.length + ' section(s) réductible(s)' : 'Aucune section à déplier', 10);
      togs.forEach(b => { try { b.click(); } catch(_) {} });
      if (togs.length) await new Promise(r => setTimeout(r, 400));

      // Étape 2 : scroll des WebParts pour déclencher lazy-load.
      // Skip complet si peu de WebParts (≤ 5) : ils sont déjà tous visibles en viewport, lazy-load
      // déjà fait par SP. Sinon on scrolle avec délai court (80ms entre chaque) et en parallèle
      // les groupes de 5 WebParts pour réduire le temps total.
      const scs = [document.scrollingElement || document.documentElement];
      document.querySelectorAll('*').forEach(e => {
        let s; try { s = getComputedStyle(e); } catch(_) { return; }
        if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && e.scrollHeight > e.clientHeight + 10) scs.push(e);
      });
      const _origScroll = scs.map(c => c === document.documentElement || c === document.body ? window.scrollY : c.scrollTop);
      const wps = document.querySelectorAll('[data-sp-feature-tag],.CanvasZone>div,[data-automation-id="CanvasSection"] > div,[data-automation-id="pageContent"] > div,section');
      const total = Math.max(wps.length, 1);
      if (wps.length <= 5) {
        STEP(2, 4, 'Page courte — scan rapide (' + wps.length + ' WebParts)', 50);
        await new Promise(r => setTimeout(r, 150));
      } else {
        // Scroll par paquets, délai 80ms par WebPart (au lieu de 280ms)
        for (let i = 0; i < wps.length; i++) {
          try { wps[i].scrollIntoView({behavior: 'instant', block: 'center'}); } catch(_) {}
          STEP(2, 4, 'Chargement des WebParts (' + (i+1) + '/' + total + ')', 20 + Math.round((i+1)/total * 50));
          await new Promise(r => setTimeout(r, 80));
        }
      }
      // Étape 3 : stabilisation — un seul scroll vers le bas + délai court
      STEP(3, 4, 'Stabilisation du contenu...', 80);
      for (const c of scs) {
        try {
          if (c === document.documentElement || c === document.body) window.scrollTo(0, document.documentElement.scrollHeight);
          else c.scrollTop = c.scrollHeight;
        } catch(_) {}
      }
      await new Promise(r => setTimeout(r, 350));
      try {
        scs.forEach((c, idx) => {
          if (c === document.documentElement || c === document.body) window.scrollTo(0, _origScroll[idx]);
          else c.scrollTop = _origScroll[idx];
        });
      } catch(_) {}
      STEP(4, 4, 'Analyse de la page...', 92);
      await new Promise(r => setTimeout(r, 100));
    } catch(e) {
      console.warn('[audit-injector] full pre-scan error:', e);
    } finally {
      cleanup();
    }
  }

  // ═══ 1er PRE-SCAN + AUDIT INITIAL ════════════════════════════════
  await runFullPreScan();
  let R;
  try {
    R = CORE.runAudit(document);
  } catch(e) {
    alert("❌ Erreur pendant l'audit : " + e.message);
    return;
  }
  const issues = R.issues || [];
  // Restaure les flags Marquer corrigé / Ignorer persistés pour cette page (URL)
  applyStoredFlagsToIssues(issues);
  const active = (i) => !i._fixed && !i._ignored;

  // 2. ─── HOST + SHADOW DOM ─────────────────────────────────────
  const host = document.createElement('div');
  host.id = '__audit-inj-host';
  host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483646;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif';
  document.body.appendChild(host);
  const shadow = host.attachShadow({mode: 'open'});

  // ─── PERSISTANCE EN MODE ÉDITION SP ───────────────────────────
  // Quand l'agent clique « Modifier » sur SharePoint, SP re-render une partie du DOM et peut
  // retirer notre host. On surveille à la fois body et document pour le ré-attacher automatiquement.
  // Les data-audit-id posés par l'audit peuvent disparaître après re-render → les pins seront
  // masqués (getElForIssue renvoie null), mais la LISTE des findings reste lisible avec le code
  // source affichable via le <details>. L'agent peut cliquer ↻ pour ré-auditer le nouveau DOM.
  let bodyObserver = null;
  let docObserver = null;
  let userClosed = false; // flag : si l'utilisateur a explicitement fermé via ×, on n'ré-attache plus
  // En mode édition SP, on conserve la liste des findings et on re-attache les pins par signature
  // DOM (via retagDOMFromIssues). Pas d'auto-rerun pour éviter de changer la liste sous l'agent.
  let inEditMode = false;
  // Sélection multiple : id → flag dans Set. Visible dans le panneau quand size > 0.
  const selectedIds = new Set();
  function toggleSelection(id) {
    if (selectedIds.has(id)) selectedIds.delete(id);
    else selectedIds.add(id);
  }
  function selectAllVisible(visibleArr) {
    visibleArr.forEach(i => selectedIds.add(i.id));
  }
  function clearSelection() { selectedIds.clear(); }
  function bulkApply(action) {
    issues.forEach(i => {
      if (!selectedIds.has(i.id)) return;
      if (action === 'fix') { i._fixed = true; i._ignored = false; }
      else if (action === 'ignore') { i._ignored = true; i._fixed = false; }
      persistFlagForIssue(i);
    });
    selectedIds.clear();
    if (!issues.find(x => x.id === activeId && active(x))) activeId = null;
  }
  // Scroll rapide qui parcourt la page (et les containers scrollables internes) du haut au bas
  // pour forcer le lazy load des images SP en mode édition. Restaure la position d'origine.
  // ~400-500ms total. Visible côté utilisateur mais court.
  async function quickScrollForLazyLoad() {
    try {
      const scrollable = document.scrollingElement || document.documentElement;
      const origDocScroll = scrollable.scrollTop;
      const maxDocScroll = scrollable.scrollHeight - scrollable.clientHeight;
      // Containers internes scrollables (CKEditor, panneaux SP)
      const containers = [];
      document.querySelectorAll('*').forEach(el => {
        if (el === host || host.contains(el)) return;
        try {
          const s = getComputedStyle(el);
          if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 100) {
            containers.push({el, orig: el.scrollTop, max: el.scrollHeight - el.clientHeight});
          }
        } catch(_) {}
      });
      // Scroll en 4 paliers (~400ms total)
      const steps = 4;
      for (let i = 1; i <= steps; i++) {
        if (maxDocScroll > 100) scrollable.scrollTop = (maxDocScroll * i) / steps;
        containers.forEach(c => { c.el.scrollTop = (c.max * i) / steps; });
        await new Promise(r => setTimeout(r, 90));
      }
      // Restaure les positions
      scrollable.scrollTop = origDocScroll;
      containers.forEach(c => { c.el.scrollTop = c.orig; });
    } catch(e) { console.warn('[audit-injector] quickScroll error:', e); }
  }

  // Re-pose les data-audit-id sur le DOM courant en se basant sur les signatures des findings.
  // Permet aux pins de réapparaître après un re-render SP (passage en édition par exemple).
  // Debounced pour éviter de spammer pendant que SP est en train de re-render.
  let retagPending = false;
  function scheduleRetagAndRenderPins() {
    if (retagPending) return;
    retagPending = true;
    setTimeout(() => {
      retagPending = false;
      try {
        if (CORE.retagDOMFromIssues) {
          const n = CORE.retagDOMFromIssues(issues, document);
          console.log('[audit-injector] retag : ' + n + ' éléments matchés sur ' + issues.length);
        }
        renderPins();
      } catch(e) { console.warn('[audit-injector] retag error:', e); }
    }, 800);
  }

  function ensureHostInDom() {
    if (userClosed) return;
    try {
      if (!document.body.contains(host)) {
        document.body.appendChild(host);
        // On garde le mode docked même en édition — pas de bascule auto en floating
        if (dockMode === 'docked') applyDockMode('docked');
        console.log('[audit-injector] host ré-attaché (SP a re-render le DOM)');
        try { renderBody(); } catch(_) {}
        scheduleRetagAndRenderPins();
      } else if (dockMode === 'docked') {
        // Re-applique les styles body si SP les a écrasés
        const expectedMargin = panel.classList.contains('collapsed') ? '56px' : (PANEL_DOCKED_WIDTH + 'px');
        if (document.body.style.marginRight !== expectedMargin) {
          document.body.style.marginRight = expectedMargin;
          document.body.style.width = 'calc(100vw - ' + expectedMargin.replace('px','') + 'px)';
        }
      }
      // Détection transitions LECTURE ↔ ÉDITION : retag (pas rerun) pour conserver les findings
      const nowEditing = detectSPEditMode();
      if (nowEditing !== inEditMode) {
        inEditMode = nowEditing;
        try { renderBody(); } catch(_) {}
        // Au passage en édition : déclenche un scroll rapide pour forcer le lazy load
        // des images SP (sinon les pins sur les images hors viewport disparaissent).
        if (nowEditing) quickScrollForLazyLoad().then(scheduleRetagAndRenderPins);
        else scheduleRetagAndRenderPins();
      }
    } catch(_) {}
  }
  function startObservers() {
    try {
      if (bodyObserver) bodyObserver.disconnect();
      if (docObserver) docObserver.disconnect();
      // Observer body pour catch les enlèvements/ajouts direct du host
      bodyObserver = new MutationObserver(() => ensureHostInDom());
      bodyObserver.observe(document.body, {childList: true, subtree: false});
      // Observer documentElement pour le cas où SP remplace body entièrement (rare mais arrive)
      docObserver = new MutationObserver(() => ensureHostInDom());
      docObserver.observe(document.documentElement, {childList: true, subtree: false});
      // Fallback : polling toutes les 2s au cas où les observers loupent un changement
      // (couvre les cas où SP fait un push DOM via React fiber sans MutationObserver event)
      setInterval(ensureHostInDom, 2000);
    } catch(_) {}
  }
  // Démarre les observers après que tout est rendu (renderPins, etc. sont définis plus bas)
  setTimeout(startObservers, 500);

  // 3. ─── STYLES (Shadow DOM, complètement isolés des styles SP) ─
  const style = document.createElement('style');
  style.textContent = `
    :host {
      --crit: #C7341B;
      --maj: #E8791D;
      --min: #6B7280;
      --inf: #0891B2;
      --bg: #FFFFFF;
      --bg-2: #F7F5F1;
      --border: #E2DED7;
      --fg: #1F1E1B;
      --fg-2: #5C5950;
      --fg-3: #8E8B83;
      --blue: #3B7CEB;
      --shadow: 0 8px 32px rgba(0,0,0,.18);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: inherit; }
    button { cursor: pointer; border: none; background: none; font: inherit; color: inherit; }

    /* Pin (point numéroté sur les éléments) — pointer-events:auto pour être cliquable
       même si le host parent est pointer-events:none.
       z-index : pins et highlights DOIVENT rester sous le panneau pour éviter de déborder dessus. */
    .pin {
      position: fixed;
      pointer-events: auto;
      width: 24px; height: 24px;
      border-radius: 99px;
      color: #fff;
      font-size: 11px; font-weight: 700;
      font-family: ui-monospace, "SF Mono", monospace;
      border: 2px solid #fff;
      box-shadow: 0 2px 8px rgba(0,0,0,.25);
      display: grid; place-items: center;
      transform: translate(-50%, -50%);
      transition: transform .12s, box-shadow .12s;
      z-index: 50;
    }
    .pin:hover { transform: translate(-50%, -50%) scale(1.2); z-index: 10; }
    .pin.active { transform: translate(-50%, -50%) scale(1.25); box-shadow: 0 0 0 4px rgba(59,124,235,.4), 0 4px 12px rgba(0,0,0,.3); }
    .pin[data-sev="critical"] { background: var(--crit); }
    .pin[data-sev="major"]    { background: var(--maj); }
    .pin[data-sev="minor"]    { background: var(--min); }
    .pin[data-sev="info"]     { background: var(--inf); }

    /* Highlight overlay sur l'élément actif — position fixed car relatif à la viewport
       (les getBoundingClientRect renvoient des coords relatives à la viewport visible)
       z-index bas : le panneau (z=200) doit le masquer s'il se superpose, pas l'inverse. */
    .hl {
      position: fixed;
      pointer-events: none;
      border-radius: 4px;
      transition: opacity .15s;
      z-index: 10;
    }
    .hl[data-sev="critical"] { outline: 2px dashed var(--crit); background: rgba(199,52,27,.05); }
    .hl[data-sev="major"]    { outline: 2px dashed var(--maj);  background: rgba(232,121,29,.05); }
    .hl[data-sev="minor"]    { outline: 1.5px dashed var(--min); background: rgba(107,114,128,.04); }
    .hl[data-sev="info"]     { outline: 1.5px dashed var(--inf); background: rgba(8,145,178,.06); }
    .hl.active {
      outline-style: solid !important;
      outline-width: 3px !important;
      box-shadow: 0 0 0 4px rgba(59,124,235,.25);
      animation: hl-pulse 2s ease-in-out infinite;
    }
    @keyframes hl-pulse {
      0%,100% { box-shadow: 0 0 0 4px rgba(59,124,235,.25); }
      50% { box-shadow: 0 0 0 8px rgba(59,124,235,.05); }
    }

    /* Tooltip au survol d'un pin — au-dessus de tout */
    .tooltip {
      position: absolute;
      pointer-events: none;
      background: #1F1E1B;
      color: #fff;
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 12px;
      line-height: 1.4;
      max-width: 320px;
      box-shadow: 0 4px 12px rgba(0,0,0,.3);
      z-index: 300;
      opacity: 0;
      transition: opacity .12s;
    }
    .tooltip.show { opacity: 1; }
    .tooltip strong { color: #fff; }
    .tooltip .sev {
      display: inline-block; font-size: 10px; font-weight: 700;
      padding: 2px 6px; border-radius: 3px; margin-right: 6px;
      text-transform: uppercase; letter-spacing: .04em;
    }
    .tooltip .sev[data-sev="critical"] { background: var(--crit); }
    .tooltip .sev[data-sev="major"]    { background: var(--maj); }
    .tooltip .sev[data-sev="minor"]    { background: var(--min); }
    .tooltip .sev[data-sev="info"]     { background: var(--inf); }

    /* Panneau latéral. Deux modes :
       - .panel.docked (par défaut) : collé à droite, hauteur 100%, body de SP rétréci → pas
         de chevauchement avec le contenu (mode « DevTools »).
       - .panel.floating : flottant arrondi (ancien mode), en overlay au-dessus du contenu. */
    .panel {
      position: fixed;
      background: var(--bg);
      display: flex; flex-direction: column;
      pointer-events: auto;
      overflow: hidden;
      z-index: 200;
      box-shadow: var(--shadow);
    }
    .panel.docked {
      top: 0; right: 0; bottom: 0;
      width: 420px;
      border-left: 1px solid var(--border);
      border-radius: 0;
      box-shadow: -4px 0 16px rgba(0,0,0,.08);
    }
    .panel.floating {
      top: 16px; right: 16px; bottom: 16px;
      width: 380px;
      border-radius: 12px;
    }
    /* Mode collapsed : bande étroite à droite, seuls logo + boutons collapse/close visibles.
       Les boutons rerun/dock sont cachés (réapparaissent au expand) car ils ne tiennent pas. */
    .panel.collapsed { width: 56px; }
    .panel.docked.collapsed { width: 56px; }
    .panel.collapsed .panel-head {
      flex-direction: column;
      padding: 10px 6px;
      gap: 6px;
      align-items: center;
    }
    .panel.collapsed .panel-head .logo { width: 32px; height: 32px; font-size: 16px; }
    .panel.collapsed .panel-title { display: none; }
    .panel.collapsed .panel-rerun, .panel.collapsed .panel-dock, .panel.collapsed .panel-pins { display: none; }
    .panel.collapsed .panel-body, .panel.collapsed .panel-tabs,
    .panel.collapsed .panel-score, .panel.collapsed .panel-foot { display: none; }
    .panel-head {
      padding: 14px 16px;
      border-bottom: 1px solid var(--border);
      display: flex; align-items: center; gap: 10px;
      background: var(--bg-2);
      flex-shrink: 0;
      user-select: none;
    }
    .panel.floating .panel-head { cursor: move; }
    .panel-head button { cursor: pointer; }
    .panel.dragging { transition: none; box-shadow: 0 12px 40px rgba(0,0,0,.32); }
    .panel-head .logo {
      width: 28px; height: 28px;
      background: linear-gradient(135deg, var(--blue), #6C5CE7);
      border-radius: 8px;
      display: grid; place-items: center;
      color: #fff; font-size: 14px;
      flex-shrink: 0;
    }
    .panel-title { flex: 1; }
    .panel-title h2 { font-size: 13px; font-weight: 700; color: var(--fg); margin: 0; }
    .panel-title .meta { font-size: 11px; color: var(--fg-3); margin-top: 2px; }
    .panel-collapse, .panel-rerun, .panel-dock, .panel-pins {
      width: 28px; height: 28px;
      border-radius: 6px;
      color: var(--fg-3);
      display: grid; place-items: center;
      transition: background .12s;
      font-size: 14px;
    }
    .panel-collapse:hover, .panel-rerun:hover, .panel-dock:hover, .panel-pins:hover { background: var(--bg-2); color: var(--fg); }
    .panel-pins.off { color: var(--maj); }
    .panel-rerun:disabled { opacity: .5; cursor: wait; }
    .panel-rerun.spinning svg { animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .panel-close {
      width: 28px; height: 28px;
      border-radius: 6px;
      color: var(--fg-3);
      display: grid; place-items: center;
      font-size: 16px;
      transition: background .12s;
    }
    .panel-close:hover { background: var(--bg-2); color: var(--crit); }

    .panel-score {
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
      display: flex; align-items: center; gap: 12px;
      flex-shrink: 0;
    }
    .score-num { font-size: 32px; font-weight: 700; line-height: 1; color: var(--fg); }
    .score-num small { font-size: 14px; font-weight: 500; color: var(--fg-3); }
    .score-info { flex: 1; }
    .score-info .label { font-size: 11px; color: var(--fg-3); text-transform: uppercase; letter-spacing: .04em; font-weight: 600; }
    .score-info .bars { display: flex; gap: 4px; margin-top: 6px; align-items: center; font-size: 11px; color: var(--fg-2); }
    .score-info .bars .b {
      display: inline-flex; align-items: center; gap: 3px;
      font-weight: 600;
    }
    .score-info .bars .b::before {
      content: ''; width: 8px; height: 8px; border-radius: 99px; display: inline-block;
    }
    .score-info .bars .crit::before { background: var(--crit); }
    .score-info .bars .maj::before  { background: var(--maj); }
    .score-info .bars .min::before  { background: var(--min); }
    .score-info .bars .inf::before  { background: var(--inf); }
    /* Bars cliquables → filtre par sévérité */
    .score-info .bars .b {
      cursor: pointer;
      padding: 2px 6px; border-radius: 99px;
      transition: background .12s, color .12s;
      user-select: none;
    }
    .score-info .bars .b:hover { background: rgba(0,0,0,.05); }
    .score-info .bars .b.active { background: var(--fg); color: #fff; }
    .score-info .bars .b.active::before { background: #fff; }
    .score-info .bars .b.dim { opacity: .35; }

    .panel-body {
      flex: 1;
      overflow-y: auto;
      padding: 8px 12px 12px;
    }

    /* Toolbar de sélection multiple — apparaît quand au moins 1 finding est coché */
    .select-toolbar {
      display: flex; align-items: center; gap: 6px;
      background: var(--bg-2);
      border: 1px solid var(--border);
      border-radius: 7px;
      padding: 6px 8px;
      margin-bottom: 8px;
      font-size: 11.5px;
      position: sticky; top: 0;
      z-index: 5;
    }
    .select-count { flex: 1; color: var(--fg-2); }
    .select-count strong { color: var(--blue); }
    .select-action {
      padding: 4px 8px;
      border-radius: 4px;
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--fg-2);
      font-size: 11px; font-weight: 600;
      cursor: pointer;
      transition: background .12s, color .12s;
    }
    .select-action:hover { background: var(--border); }
    .select-action.select-fix:hover { background: var(--inf); border-color: var(--inf); color: #fff; }
    .select-action.select-ign:hover { background: var(--fg-2); border-color: var(--fg-2); color: #fff; }

    /* Card-head-row : checkbox à gauche, head cliquable à droite */
    .card-head-row { display: flex; align-items: stretch; }
    .card-select {
      flex: 0 0 24px;
      margin: 9px 0 9px 10px;
      cursor: pointer;
      width: 14px; height: 14px;
      align-self: start;
    }
    .card-head-row .card-head { flex: 1; }
    .card.selected { border-color: var(--blue); box-shadow: 0 0 0 1px var(--blue), 0 2px 6px rgba(59,124,235,.15); }
    .card.selected .card-head { background: rgba(59,124,235,.04); }

    /* Bandeau d'info quand on est en mode édition SP — explique pourquoi les pins ne sont plus là */
    .edit-mode-banner {
      display: flex; gap: 10px; align-items: flex-start;
      background: linear-gradient(135deg, #FEF3C7, #FCD34D33);
      border: 1px solid #F59E0B;
      border-left-width: 4px;
      border-radius: 7px;
      padding: 10px 12px;
      margin-bottom: 10px;
      font-size: 12px;
      line-height: 1.5;
      color: #78350F;
    }
    .edit-mode-icon { font-size: 18px; flex-shrink: 0; line-height: 1; padding-top: 1px; }
    .edit-mode-body { flex: 1; }
    .edit-mode-body strong { color: #57280A; }

    /* Carte issue (head cliquable + body dépliable inline) */
    .card {
      border: 1px solid var(--border);
      border-radius: 8px;
      margin-bottom: 6px;
      background: var(--bg);
      overflow: hidden;
    }
    .card-head {
      display: grid;
      grid-template-columns: auto auto 1fr auto;
      align-items: center;
      gap: 10px;
      padding: 9px 10px;
      width: 100%;
      text-align: left;
      background: var(--bg);
      color: var(--fg);
      transition: background .1s;
      cursor: pointer;
    }
    .card-head:hover { background: var(--bg-2); }
    .card.expanded { border-color: rgba(59,124,235,.45); box-shadow: 0 2px 8px rgba(0,0,0,.06); }
    .card.expanded .card-head { background: var(--bg-2); }
    .row-num {
      width: 20px; height: 20px;
      border-radius: 99px;
      color: #fff;
      display: grid; place-items: center;
      font-family: ui-monospace, "SF Mono", monospace;
      font-size: 10px; font-weight: 700;
      flex-shrink: 0;
    }
    .card[data-sev="critical"] .row-num { background: var(--crit); }
    .card[data-sev="major"]    .row-num { background: var(--maj); }
    .card[data-sev="minor"]    .row-num { background: var(--min); }
    .card[data-sev="info"]     .row-num { background: var(--inf); }
    .row-sev {
      font-family: ui-monospace, "SF Mono", monospace;
      font-size: 9.5px; font-weight: 700;
      letter-spacing: .08em; text-transform: uppercase;
      color: var(--fg-3);
    }
    .card[data-sev="critical"] .row-sev { color: var(--crit); }
    .card[data-sev="major"]    .row-sev { color: var(--maj); }
    .card[data-sev="minor"]    .row-sev { color: var(--min); }
    .card[data-sev="info"]     .row-sev { color: var(--inf); }
    .row-text {
      font-size: 12.5px;
      color: var(--fg);
      line-height: 1.4;
      word-break: break-word;
      overflow-wrap: anywhere;
    }
    .card-head { align-items: start; }
    .card-head .row-num, .card-head .row-sev, .card-head .row-chev { margin-top: 1px; }
    .row-chev {
      color: var(--fg-3);
      font-size: 16px;
      transition: transform .15s;
      display: inline-block;
      line-height: 1;
    }
    .card.expanded .row-chev { transform: rotate(90deg); color: var(--blue); }

    /* Corps déplié de la carte */
    .card-body {
      padding: 4px 14px 12px;
      background: var(--bg-2);
      border-top: 1px solid var(--border);
      font-size: 12.5px;
      line-height: 1.55;
      color: var(--fg-2);
    }
    .card-body .wcag-ref {
      font-size: 11px;
      color: var(--fg-3);
      font-family: ui-monospace, "SF Mono", monospace;
      padding-top: 10px;
    }
    .card-reco { margin-top: 8px; }
    .card-reco p { margin: 0 0 6px; }
    .card-reco strong { color: var(--fg); }
    .card-reco code {
      background: var(--bg); padding: 1px 5px; border-radius: 3px;
      font-family: ui-monospace, "SF Mono", monospace; font-size: 11.5px;
      color: var(--fg);
    }
    .card-code {
      margin-top: 10px;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 5px;
      font-size: 11px;
    }
    .card-code summary {
      padding: 6px 10px;
      cursor: pointer;
      color: var(--fg-2);
      font-weight: 600;
      list-style: none;
      user-select: none;
    }
    .card-code summary::-webkit-details-marker { display: none; }
    .card-code summary::before { content: '▸ '; }
    .card-code[open] summary::before { content: '▾ '; }
    .card-code summary:hover { background: var(--bg-2); border-radius: 5px; }
    .card-code pre {
      margin: 0; padding: 8px 10px;
      border-top: 1px solid var(--border);
      font-family: ui-monospace, "SF Mono", monospace;
      font-size: 11px;
      color: var(--fg-2);
      white-space: pre-wrap;
      word-break: break-all;
      max-height: 200px;
      overflow-y: auto;
    }

    .card-actions {
      display: flex; gap: 6px;
      margin-top: 12px; padding-top: 10px;
      border-top: 1px dashed var(--border);
    }
    .card-actions button {
      flex: 1; padding: 6px 8px;
      border-radius: 5px;
      font-size: 12px; font-weight: 600;
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--fg-2);
      cursor: pointer;
      transition: background .1s, color .1s, border-color .1s;
    }
    .card-actions .btn-fix:hover    { background: var(--inf); border-color: var(--inf); color: #fff; }
    .card-actions .btn-ignore:hover { background: var(--fg-2); border-color: var(--fg-2); color: #fff; }

    /* Section Suggestions IA dans la carte dépliée */
    .ai-section {
      margin-top: 12px;
      padding: 10px 12px;
      background: linear-gradient(135deg, rgba(142,78,198,0.07), rgba(59,124,235,0.06));
      border: 1px solid rgba(142,78,198,0.22);
      border-radius: 7px;
    }
    .ai-section-label {
      font-size: 10.5px; font-weight: 700;
      color: #6b34c4;
      text-transform: uppercase; letter-spacing: .06em;
      margin-bottom: 8px;
      display: flex; align-items: center; gap: 6px;
    }
    .btn-ai-issue {
      width: 100%;
      background: linear-gradient(135deg, #8E4EC6, #3B7CEB);
      color: #fff; border: none;
      padding: 7px 12px; border-radius: 5px;
      font-size: 12px; font-weight: 600;
      cursor: pointer;
      transition: filter .12s;
    }
    .btn-ai-issue:hover { filter: brightness(1.1); }
    .btn-ai-issue:disabled { opacity: .6; cursor: wait; }
    .btn-ai-edit-prompt {
      background: var(--bg);
      color: var(--fg-2);
      border: 1px solid var(--border);
      padding: 6px 10px;
      border-radius: 5px;
      font-size: 11.5px; font-weight: 600;
      cursor: pointer;
      transition: background .12s;
      white-space: nowrap;
    }
    .btn-ai-edit-prompt:hover { background: var(--bg-2); }
    /* Mode édition structuré : bloc lecture seule + champs éditables compacts */
    .ai-edit-readonly-block {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 5px;
      padding: 8px 10px;
      margin-bottom: 10px;
      font-size: 11.5px;
    }
    .ai-edit-readonly-row { display: flex; gap: 8px; padding: 3px 0; }
    .ai-edit-readonly-row + .ai-edit-readonly-row { border-top: 1px dashed var(--border); margin-top: 3px; padding-top: 6px; }
    .ai-edit-rolabel {
      flex: 0 0 auto;
      min-width: 80px;
      font-weight: 600;
      color: var(--fg-3);
      text-transform: uppercase;
      font-size: 9.5px;
      letter-spacing: .05em;
      padding-top: 2px;
    }
    .ai-edit-rovalue { flex: 1; color: var(--fg-2); line-height: 1.4; word-break: break-word; }
    .ai-edit-rosource { font-family: inherit; white-space: pre-wrap; }

    .ai-edit-field { margin-bottom: 10px; }
    .ai-edit-label {
      display: block;
      font-size: 10.5px;
      font-weight: 700;
      color: var(--fg-2);
      text-transform: uppercase;
      letter-spacing: .04em;
      margin-bottom: 4px;
    }
    .ai-edit-hint { font-weight: 500; color: var(--fg-3); text-transform: none; letter-spacing: 0; font-size: 10px; }
    .ai-edit-input, .ai-edit-textarea {
      width: 100%;
      padding: 6px 9px;
      border: 1px solid var(--border);
      border-radius: 5px;
      background: var(--bg);
      color: var(--fg);
      font-size: 12px;
      font-family: inherit;
      box-sizing: border-box;
      line-height: 1.45;
    }
    .ai-edit-textarea { resize: vertical; min-height: 50px; }
    .ai-edit-input:focus, .ai-edit-textarea:focus {
      outline: 2px solid rgba(142,78,198,.3);
      outline-offset: -1px;
      border-color: rgba(142,78,198,.45);
    }

    .ai-edit-actions {
      display: flex; gap: 6px; align-items: center;
      margin-top: 4px;
    }
    .ai-edit-actions .btn-ai-issue { flex: 1; }
    .ai-edit-icon-btn {
      flex: 0 0 30px;
      width: 30px; height: 30px;
      border-radius: 5px;
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--fg-2);
      font-size: 14px;
      cursor: pointer;
      transition: background .12s, color .12s;
      display: grid; place-items: center;
    }
    .ai-edit-icon-btn:hover { background: var(--bg-2); color: var(--fg); }
    .ai-edit-cancel {
      flex: 0 0 auto;
      background: transparent;
      color: var(--fg-3);
      border: 1px solid var(--border);
      padding: 6px 12px;
      border-radius: 5px;
      font-size: 11.5px;
      cursor: pointer;
      font-family: inherit;
    }
    .ai-edit-cancel:hover { background: var(--bg-2); color: var(--fg); }
    .ai-hint { font-size: 11px; color: var(--fg-3); margin-top: 6px; line-height: 1.4; }
    .ai-loading {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 10px; font-size: 12px; color: var(--fg-2);
      background: var(--bg); border-radius: 5px;
    }
    .ai-spinner {
      width: 12px; height: 12px;
      border: 2px solid #ddd; border-top-color: #8E4EC6;
      border-radius: 99px;
      animation: ai-spin .8s linear infinite;
    }
    @keyframes ai-spin { to { transform: rotate(360deg); } }
    .ai-error {
      background: #FFF1E0; border: 1px solid #FFA94D; border-radius: 5px;
      padding: 8px 10px; font-size: 11.5px; color: #6F3E0E;
      margin-bottom: 8px; line-height: 1.45;
    }
    .ai-error strong { display: block; margin-bottom: 3px; }
    .ai-option {
      display: grid; grid-template-columns: 20px 1fr auto;
      gap: 8px; align-items: start;
      background: var(--bg); border: 1px solid var(--border); border-radius: 5px;
      padding: 8px 10px; margin-bottom: 6px;
    }
    .ai-option-num {
      width: 20px; height: 20px; border-radius: 99px;
      background: linear-gradient(135deg, #8E4EC6, #3B7CEB); color: #fff;
      display: grid; place-items: center;
      font-size: 10px; font-weight: 700;
      font-family: ui-monospace, "SF Mono", monospace;
    }
    .ai-option-text { font-size: 12.5px; color: var(--fg); line-height: 1.45; word-break: break-word; }
    .ai-option-note { font-size: 11px; color: var(--fg-3); margin-top: 3px; font-style: italic; }
    .ai-option-copy {
      background: var(--bg-2); color: var(--fg-2); border: 1px solid var(--border);
      padding: 4px 8px; border-radius: 4px;
      font-size: 10.5px; font-weight: 600;
      cursor: pointer; transition: background .12s;
      white-space: nowrap;
    }
    .ai-option-copy:hover { background: var(--border); }
    .ai-option-copy:disabled { background: rgba(8,145,178,.15); color: var(--inf); cursor: default; }

    /* Tabs « Problèmes / Titres » sous l'en-tête */
    .panel-tabs {
      display: flex;
      border-bottom: 1px solid var(--border);
      background: var(--bg-2);
      flex-shrink: 0;
    }
    .panel-tab {
      flex: 1;
      padding: 8px 10px;
      font-size: 12px; font-weight: 600;
      color: var(--fg-3);
      border-bottom: 2px solid transparent;
      transition: color .12s, border-color .12s;
      cursor: pointer;
    }
    .panel-tab:hover { color: var(--fg-2); }
    .panel-tab.active { color: var(--blue); border-bottom-color: var(--blue); }
    .panel-tab .count {
      display: inline-block;
      font-size: 10px; font-weight: 700;
      padding: 1px 6px; margin-left: 4px;
      background: rgba(0,0,0,.06); color: var(--fg-2);
      border-radius: 99px;
      vertical-align: middle;
    }
    .panel-tab.active .count { background: var(--blue); color: #fff; }

    /* Vue Hiérarchie des titres */
    .h-list { padding: 6px 4px; }
    .h-row {
      display: flex; align-items: baseline; gap: 8px;
      padding: 6px 8px;
      border-radius: 6px;
      cursor: pointer;
      transition: background .1s;
    }
    .h-row:hover { background: var(--bg-2); }
    .h-row .h-tag {
      font-family: ui-monospace, "SF Mono", monospace;
      font-size: 10px; font-weight: 700;
      padding: 2px 6px; border-radius: 4px;
      background: var(--bg-2); color: var(--fg-2);
      flex-shrink: 0;
    }
    .h-row[data-lvl="1"] .h-tag { background: rgba(59,124,235,.18); color: var(--blue); }
    .h-row[data-lvl="2"] .h-tag { background: rgba(59,124,235,.12); color: var(--blue); }
    .h-row .h-txt {
      font-size: 12.5px; line-height: 1.4;
      color: var(--fg);
      word-break: break-word;
    }
    .h-row.empty .h-txt { color: var(--fg-3); font-style: italic; }
    .h-row.empty .h-tag { background: rgba(232,121,29,.15); color: var(--maj); }
    .h-empty-msg { padding: 24px 16px; color: var(--fg-3); font-size: 13px; text-align: center; line-height: 1.5; }

    /* Footer compteur ignorés/corrigés */
    .list-foot {
      margin-top: 10px;
      padding: 8px 6px;
      font-size: 11.5px;
      color: var(--fg-3);
      display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
    }
    .list-foot button {
      font-size: 11.5px; color: var(--blue);
      text-decoration: underline;
      padding: 0;
      cursor: pointer;
    }

    /* Footer with "open full audit" */
    .panel-foot {
      padding: 10px 16px;
      border-top: 1px solid var(--border);
      background: var(--bg-2);
      display: flex; gap: 8px; flex-wrap: wrap;
      flex-shrink: 0;
    }
    .btn-update {
      flex-basis: 100%;
      padding: 8px 12px;
      background: var(--bg-2);
      color: var(--fg);
      border: 1px solid var(--border);
      border-radius: 6px;
      font-size: 12.5px; font-weight: 600;
      text-align: center;
      cursor: pointer;
      transition: background .12s;
    }
    .btn-update:hover { background: var(--border); }
    .btn-update:disabled { opacity: .6; cursor: wait; }
    .btn-update.has-update {
      background: var(--blue); color: #fff; border-color: var(--blue);
    }
    .btn-update.has-update:hover { filter: brightness(1.08); background: var(--blue); }

    /* Toast (résultat du check MAJ) — dans le shadow, au-dessus du panneau */
    .a-toast {
      position: fixed; top: 14px; left: 50%; transform: translateX(-50%);
      z-index: 2147483647; pointer-events: auto;
      background: #fff; color: #1F1E1B;
      border-left: 4px solid var(--blue);
      box-shadow: 0 6px 24px rgba(0,0,0,.22);
      border-radius: 8px; padding: 12px 16px;
      font-size: 13px; line-height: 1.5; max-width: 380px;
      transition: opacity .35s;
    }
    .a-toast.ok   { border-left-color: var(--inf); }
    .a-toast.warn { border-left-color: var(--maj); }
    .btn-full {
      flex: 1;
      padding: 8px 12px;
      background: var(--blue);
      color: #fff;
      border-radius: 6px;
      font-size: 12.5px; font-weight: 600;
      text-align: center;
    }
    .btn-full:hover { filter: brightness(1.08); }
    .btn-rescan {
      flex: 1;
      padding: 8px 12px;
      background: var(--bg-2);
      color: var(--fg);
      border: 1px solid var(--border);
      border-radius: 6px;
      font-size: 12.5px; font-weight: 600;
      text-align: center;
      cursor: pointer;
      transition: background .12s;
    }
    .btn-rescan:hover { background: var(--border); }
    .btn-rescan:disabled { opacity: .5; cursor: wait; }

    .empty { padding: 32px 16px; text-align: center; color: var(--fg-3); font-size: 13px; }
  `;
  shadow.appendChild(style);

  // 4. ─── PANNEAU LATÉRAL ───────────────────────────────────────
  const PANEL_DOCKED_WIDTH = 420;
  const panel = document.createElement('div');
  panel.className = 'panel docked';
  shadow.appendChild(panel);

  // Mode docked : body de SP rétréci de PANEL_DOCKED_WIDTH px à droite, panneau occupe la
  // bande droite à 100% de hauteur. Le contenu SP reste entièrement visible, plus de chevauchement.
  // On sauvegarde les styles originaux du body/html pour pouvoir les restaurer au close.
  //
  // EXCEPTION : si on détecte que SP est en mode édition (URL ?Mode=Edit, ou présence du panneau
  // d'édition), on force le mode flottant. Sinon notre body{margin-right:420} casse le layout de
  // l'éditeur SP (toolbar, panneau properties, drag&drop des WebParts).
  function detectSPEditMode() {
    try {
      const url = location.href || '';
      if (/[?&](Mode|mode)=Edit/i.test(url)) return true;
      // Présence de la barre d'édition canvas / panneau properties
      if (document.querySelector('[data-automation-id="canvasOverlay"]')) return true;
      if (document.querySelector('[data-automation-id="propertyPanePopupHost"]')) return true;
      if (document.querySelector('.spPageCanvasContent[data-canvas-mode="edit"]')) return true;
      if (document.querySelector('[data-sp-canvas-mode="edit"]')) return true;
    } catch(_) {}
    return false;
  }
  const initialEditMode = detectSPEditMode();
  // Toujours docked par défaut (le user peut basculer en flottant via le bouton 📌)
  let dockMode = 'docked'; // 'docked' | 'floating'
  const ORIG_STYLES = {
    bodyMarginRight: document.body.style.marginRight,
    bodyWidth: document.body.style.width,
    bodyTransition: document.body.style.transition,
    htmlOverflowX: document.documentElement.style.overflowX,
  };
  function applyDockMode(mode) {
    dockMode = mode;
    if (mode === 'docked') {
      panel.classList.remove('floating');
      panel.classList.add('docked');
      // Largeur dépend de l'état collapsed (56) ou normal (420)
      const w = panel.classList.contains('collapsed') ? 56 : PANEL_DOCKED_WIDTH;
      document.body.style.transition = 'margin .2s ease, width .2s ease';
      document.body.style.marginRight = w + 'px';
      document.body.style.width = 'calc(100vw - ' + w + 'px)';
      document.documentElement.style.overflowX = 'hidden';
      try { window.dispatchEvent(new Event('resize')); } catch(_) {}
    } else {
      panel.classList.remove('docked');
      panel.classList.add('floating');
      restoreBodyStyles();
    }
    try { renderPins(); } catch(_) {}
  }
  function restoreBodyStyles() {
    document.body.style.marginRight = ORIG_STYLES.bodyMarginRight;
    document.body.style.width = ORIG_STYLES.bodyWidth;
    document.body.style.transition = ORIG_STYLES.bodyTransition;
    document.documentElement.style.overflowX = ORIG_STYLES.htmlOverflowX;
    try { window.dispatchEvent(new Event('resize')); } catch(_) {}
  }

  // Squelette du panneau — meta/score/body sont remplis par renderHeadScore() et renderBody()
  panel.innerHTML = `
    <div class="panel-head">
      <div class="logo">♿</div>
      <div class="panel-title">
        <h2>Audit accessibilité</h2>
        <div class="meta"></div>
      </div>
      <button class="panel-pins" title="Masquer les repères sur la page">👁</button>
      <button class="panel-rerun" title="Relancer l'audit"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15.5-6.3L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.3L3 16"/><path d="M3 21v-5h5"/></svg></button>
      <button class="panel-dock" title="Basculer mode flottant / fixé">📌</button>
      <button class="panel-collapse" title="Réduire">⇥</button>
      <button class="panel-close" title="Fermer l'audit">×</button>
    </div>
    <div class="panel-score">
      <div class="score-num">0<small>/100</small></div>
      <div class="score-info">
        <div class="label">Score</div>
        <div class="bars">
          <span class="b crit">0</span>
          <span class="b maj">0</span>
          <span class="b min">0</span>
          <span class="b inf">0</span>
        </div>
      </div>
    </div>
    <div class="panel-tabs">
      <button class="panel-tab active" data-tab="issues">Problèmes <span class="count" id="tab-count-issues">0</span></button>
      <button class="panel-tab" data-tab="headings">Titres <span class="count" id="tab-count-headings">0</span></button>
    </div>
    <div class="panel-body" id="body"></div>
    <div class="panel-foot">
      <button class="btn-rescan" id="fullRescan" title="Re-scan complet avec overlay : ouvre toutes les sections, scrolle les WebParts, recharge le contenu lazy. Utile après de gros changements sur la page.">🔍 Re-scan complet</button>
      <button class="btn-full" id="openFull" title="Ouvre la page d'audit standalone dans un nouvel onglet (audit hors-ligne du HTML capturé)">📊 Voir l'audit complet</button>
      <button class="btn-update" id="checkUpdate" title="Vérifier si une nouvelle version de l'outil est disponible">🔄 Vérifier les mises à jour</button>
    </div>
  `;

  const body = shadow.querySelector('#body');
  let activeId = null; // toutes cartes fermées au départ — l'utilisateur clique pour déplier
  let activeTab = 'issues'; // 'issues' | 'headings'
  let severityFilter = null; // null = tous, sinon 'critical'|'major'|'minor'|'info'
  let pinsVisible = true; // bouton 👁 du header : masquer/afficher les repères sur la page
  // État IA par issue : {issueId: {loading, options, error}} — utilisé pour le bouton « Suggestions IA »
  const aiByIssue = {};
  // Hiérarchie des titres extraits par runAudit
  let headings = R.headings || [];

  // Filtre commun pour les listes (combine active + severityFilter)
  function isVisible(i) {
    if (!active(i)) return false;
    if (severityFilter && i.severity !== severityFilter) return false;
    return true;
  }

  // Recalcule + injecte le score/compteurs dans l'en-tête. À appeler après chaque modif d'issues.
  function renderHeadScore() {
    const ac = issues.filter(active).length;
    const c = {
      critical: issues.filter(i => active(i) && i.severity === 'critical').length,
      major:    issues.filter(i => active(i) && i.severity === 'major').length,
      minor:    issues.filter(i => active(i) && i.severity === 'minor').length,
      info:     issues.filter(i => active(i) && i.severity === 'info').length,
    };
    const pen = c.critical*15 + c.major*8 + c.minor*3 + c.info;
    const sc = Math.max(0, Math.min(100, Math.round(100 - Math.min(100, pen))));
    shadow.querySelector('.panel-title .meta').textContent = ac + ' problème' + (ac>1?'s':'') + ' · WCAG/RGAA';
    shadow.querySelector('.score-num').innerHTML = sc + '<small>/100</small>';
    const bars = shadow.querySelectorAll('.bars .b');
    bars[0].textContent = c.critical;
    bars[1].textContent = c.major;
    bars[2].textContent = c.minor;
    bars[3].textContent = c.info;
    // Compteurs des onglets
    const tCntI = shadow.querySelector('#tab-count-issues');
    if (tCntI) tCntI.textContent = ac;
    const tCntH = shadow.querySelector('#tab-count-headings');
    if (tCntH) tCntH.textContent = headings.length;
    // Highlight de la barre filtrée + dim des autres
    const sevMap = {critical: 'crit', major: 'maj', minor: 'min', info: 'inf'};
    shadow.querySelectorAll('.bars .b').forEach(b => {
      b.classList.remove('active', 'dim');
      if (severityFilter) {
        const cls = sevMap[severityFilter];
        if (b.classList.contains(cls)) b.classList.add('active');
        else b.classList.add('dim');
      }
    });
  }
  renderHeadScore();
  // Clic sur les bars du score → filtre par sévérité (toggle)
  shadow.querySelectorAll('.bars .b').forEach(b => {
    const sevMap = {crit: 'critical', maj: 'major', min: 'minor', inf: 'info'};
    b.style.cursor = 'pointer';
    b.title = 'Cliquer pour filtrer par cette sévérité';
    b.onclick = () => {
      // Trouve la classe sev pour cette bar
      const cls = ['crit','maj','min','inf'].find(c => b.classList.contains(c));
      if (!cls) return;
      const wantedSev = sevMap[cls];
      // Toggle : re-clic sur la même → désactive le filtre
      severityFilter = (severityFilter === wantedSev) ? null : wantedSev;
      activeId = null;
      renderHeadScore();
      renderBody();
      renderPins();
    };
  });

  // 5. ─── ROUTER + RENDU ────────────────────────────────────────
  // Le panneau a deux onglets : Problèmes (cards accordion) et Titres (hiérarchie).
  function renderBody() {
    if (activeTab === 'headings') return renderHeadings();
    return renderIssuesList();
  }
  function renderHeadings() {
    if (!headings.length) {
      body.innerHTML = `<div class="h-empty-msg">Aucun titre détecté dans le contenu éditable.</div>`;
      return;
    }
    // Indentation par niveau (0 à 5) + tag H1..H6 + texte ou « (vide) »
    let h = '<div class="h-list">';
    headings.forEach(hd => {
      const indent = (hd.level - 1) * 14;
      const isEmpty = !hd.text;
      const txt = isEmpty ? '(titre vide — WebPart sans intitulé)' : hd.text;
      h += `<div class="h-row${isEmpty?' empty':''}" data-lvl="${hd.level}" style="padding-left:${8+indent}px">
        <span class="h-tag">H${hd.level}${hd.isAria?'*':''}</span>
        <span class="h-txt">${escapeHtml(txt)}</span>
      </div>`;
    });
    h += '</div>';
    h += '<div class="ai-hint" style="padding:8px 12px;color:var(--fg-3);font-size:11px"><strong>*</strong> = titre construit via <code>role="heading"</code> (Aria), pas une balise H native.</div>';
    body.innerHTML = h;
  }
  function renderIssuesList() {
    if (!issues.length) {
      body.innerHTML = `<div class="empty">🎉 Aucun problème détecté !</div>`;
      return;
    }
    const SEV_SHORT = {critical:'crit',major:'maj',minor:'min',info:'inf'};
    const SEV_LBL = {critical:'critiques',major:'majeurs',minor:'mineurs',info:'infos'};
    const visible = issues.filter(isVisible);
    let h = '';
    // Toolbar sélection multiple — visible quand au moins 1 finding est coché
    if (selectedIds.size > 0) {
      const allVisibleSelected = visible.length > 0 && visible.every(i => selectedIds.has(i.id));
      h += `<div class="select-toolbar">
        <span class="select-count"><strong>${selectedIds.size}</strong> sélectionné${selectedIds.size>1?'s':''}</span>
        <button class="select-action" data-bulk="select-all" title="${allVisibleSelected ? 'Tout désélectionner' : 'Tout sélectionner'}">${allVisibleSelected ? '☐ Tout désél.' : '☑ Tout sél.'}</button>
        <button class="select-action select-fix" data-bulk="fix" title="Marquer la sélection comme corrigée">✓ Corrigé</button>
        <button class="select-action select-ign" data-bulk="ignore" title="Ignorer la sélection">⊘ Ignorer</button>
        <button class="select-action" data-bulk="clear" title="Annuler la sélection">✕</button>
      </div>`;
    }
    // Bandeau d'info en mode édition SP : les findings sont conservés, les pins re-attachés au mieux
    if (inEditMode) {
      h += `<div class="edit-mode-banner">
        <div class="edit-mode-icon">📝</div>
        <div class="edit-mode-body">
          <strong>Mode édition SharePoint</strong><br>
          La liste des findings est conservée. Les pins ont été ré-attachés au mieux sur les éléments retrouvés (images, liens, titres, paragraphes). Quelques findings peuvent ne pas avoir de pin si l'élément n'est pas matchable.<br>
          <span style="opacity:.85;font-size:11px">Pour re-auditer le contenu après vos corrections, cliquez ↻ Relancer.</span>
        </div>
      </div>`;
    }
    // Banderole d'info quand un filtre sévérité est actif
    if (severityFilter) {
      h += `<div style="padding:8px 10px;background:var(--bg-2);border:1px solid var(--border);border-radius:6px;margin-bottom:8px;font-size:12px;color:var(--fg-2);display:flex;justify-content:space-between;align-items:center"><span>Filtre : <strong>${SEV_LBL[severityFilter]||''}</strong> uniquement (${visible.length})</span><button data-clear-filter style="background:transparent;border:none;color:var(--blue);font-size:11px;cursor:pointer;font-weight:600">× Tout afficher</button></div>`;
    }
    if (!visible.length) {
      h += `<div class="empty">${severityFilter ? 'Aucun problème dans cette catégorie.' : '🎉 Tous les problèmes sont traités.'}</div>`;
    }
    visible.forEach(i => {
      const open = i.id === activeId;
      const isSel = selectedIds.has(i.id);
      h += `
        <div class="card${open?' expanded':''}${isSel?' selected':''}" data-sev="${i.severity}" data-id="${i.id}">
          <div class="card-head-row">
            <input type="checkbox" class="card-select" data-select-id="${i.id}" ${isSel?'checked':''} title="Sélectionner pour action groupée">
            <button class="card-head" data-toggle="${i.id}">
              <span class="row-num">${i.id}</span>
              <span class="row-sev">${SEV_SHORT[i.severity]||''}</span>
              <span class="row-text">${escapeHtml(i.message)}</span>
              <span class="row-chev">›</span>
            </button>
          </div>
          ${open ? `
            <div class="card-body">
              <div class="wcag-ref">WCAG ${i.wcag}${i.rgaa?' · RGAA '+i.rgaa:''}${i.context?' · '+escapeHtml(i.context):''}</div>
              <div class="card-reco">${CORE.renderRecommendation ? CORE.renderRecommendation(i.recommendation) : '<p>'+escapeHtml(i.recommendation)+'</p>'}</div>
              <details class="card-code"><summary>Voir le code concerné</summary><pre>${i.code ? escapeHtml(i.code) : (i.sourceText ? escapeHtml(i.sourceText) : "(Issue de niveau page — pas d'élément HTML spécifique. Voir « " + escapeHtml(i.element || 'détails') + " » dans la recommandation ci-dessus.)")}</pre></details>
              ${i.aiReformulable ? renderAISection(i) : ''}
              <div class="card-actions">
                <button class="btn-fix"    data-action="fix"    data-id="${i.id}" title="Marquer corrigé (retirer du listing)">✓ Marquer corrigé</button>
                <button class="btn-ignore" data-action="ignore" data-id="${i.id}" title="Ignorer (faux positif, non applicable)">⊘ Ignorer</button>
              </div>
            </div>` : ''}
        </div>
      `;
    });
    // Footer compteur si quelque chose a été ignoré/corrigé
    const fixedN = issues.filter(i => i._fixed).length;
    const ignoredN = issues.filter(i => i._ignored).length;
    if (fixedN + ignoredN > 0) {
      const parts = [];
      if (fixedN) parts.push(fixedN + ' corrigé' + (fixedN>1?'s':''));
      if (ignoredN) parts.push(ignoredN + ' ignoré' + (ignoredN>1?'s':''));
      h += `<div class="list-foot">${parts.join(' · ')}<button data-action="reset">↺ Tout réafficher</button></div>`;
    }
    body.innerHTML = h;
    // Bouton « × Tout afficher » dans la banderole de filtre
    const clearBtn = body.querySelector('[data-clear-filter]');
    if (clearBtn) clearBtn.onclick = () => {
      severityFilter = null;
      renderHeadScore();
      renderBody();
      renderPins();
    };
    // Checkbox de sélection (sans déplier la card)
    body.querySelectorAll('[data-select-id]').forEach(cb => {
      cb.onclick = (e) => { e.stopPropagation(); };
      cb.onchange = (e) => {
        e.stopPropagation();
        const id = +cb.dataset.selectId;
        toggleSelection(id);
        renderBody();
      };
    });
    // Toolbar de sélection : actions groupées
    body.querySelectorAll('[data-bulk]').forEach(b => {
      b.onclick = (e) => {
        e.stopPropagation();
        const a = b.dataset.bulk;
        if (a === 'select-all') {
          const allVisibleSelected = visible.length > 0 && visible.every(i => selectedIds.has(i.id));
          if (allVisibleSelected) clearSelection();
          else selectAllVisible(visible);
        } else if (a === 'fix' || a === 'ignore') {
          bulkApply(a);
        } else if (a === 'clear') {
          clearSelection();
        }
        renderHeadScore();
        renderBody();
        renderPins();
      };
    });
    // Toggle expand
    body.querySelectorAll('[data-toggle]').forEach(b => {
      b.onclick = (e) => {
        e.stopPropagation();
        const id = +b.dataset.toggle;
        setActive(activeId === id ? null : id);
      };
    });
    // Actions Ignorer / Corriger / Reset
    body.querySelectorAll('[data-action]').forEach(b => {
      b.onclick = (e) => {
        e.stopPropagation();
        const a = b.dataset.action;
        if (a === 'reset') {
          issues.forEach(x => { x._fixed = false; x._ignored = false; });
          // Efface aussi le localStorage pour cette page
          clearAllStoredFlagsForPage();
        } else {
          const id = +b.dataset.id;
          const i = issues.find(x => x.id === id);
          if (!i) return;
          if (a === 'fix') i._fixed = true;
          else if (a === 'ignore') i._ignored = true;
          // Persiste le flag pour qu'il survive aux re-audits / sessions
          persistFlagForIssue(i);
          if (id === activeId) activeId = issues.find(active)?.id || null;
        }
        renderHeadScore();
        renderBody();
        renderPins();
      };
    });
    // Bouton « Suggestions IA » — envoi direct avec prompt par défaut
    body.querySelectorAll('[data-ai-action="suggest"]').forEach(b => {
      b.onclick = (e) => {
        e.stopPropagation();
        aiSuggestForIssue(+b.dataset.id);
      };
    });
    // Bouton « ✏️ Voir/modifier le prompt » — bascule en mode édition structuré
    body.querySelectorAll('[data-ai-action="edit-prompt"]').forEach(b => {
      b.onclick = (e) => {
        e.stopPropagation();
        const id = +b.dataset.id;
        const issue = issues.find(x => x.id === id);
        if (!issue) return;
        const def = (CORE.aiPromptDefaults ? CORE.aiPromptDefaults(issue, false) : {audience:'', constraints:''});
        const existing = aiByIssue[id] || {};
        aiByIssue[id] = Object.assign({}, existing, {
          editingPrompt: true,
          editAudience: existing.editAudience != null ? existing.editAudience : def.audience,
          editConstraints: existing.editConstraints != null ? existing.editConstraints : def.constraints,
          editExtra: existing.editExtra || '',
          loading: false,
          error: null,
        });
        renderBody();
      };
    });
    // Capture en live les valeurs des champs édités (pour qu'ils survivent à un re-render)
    body.querySelectorAll('[data-edit-field]').forEach(el => {
      el.oninput = (e) => {
        const id = +el.dataset.id;
        const field = el.dataset.editField;
        if (!aiByIssue[id]) return;
        if (field === 'audience') aiByIssue[id].editAudience = el.value;
        else if (field === 'constraints') aiByIssue[id].editConstraints = el.value;
        else if (field === 'extra') aiByIssue[id].editExtra = el.value;
      };
    });
    // Bouton « Envoyer » — collecte les 3 champs et envoie l'IA avec ces overrides
    body.querySelectorAll('[data-ai-action="send-edited"]').forEach(b => {
      b.onclick = (e) => {
        e.stopPropagation();
        const id = +b.dataset.id;
        const st = aiByIssue[id] || {};
        const overrides = {
          audience: st.editAudience || '',
          constraints: st.editConstraints != null ? st.editConstraints : '',
          extra: st.editExtra || '',
        };
        st.editingPrompt = false;
        renderBody();
        aiSuggestForIssue(id, overrides);
      };
    });
    // Bouton ↺ « Réinitialiser » — remet les 3 champs aux valeurs par défaut
    body.querySelectorAll('[data-ai-action="reset-prompt"]').forEach(b => {
      b.onclick = (e) => {
        e.stopPropagation();
        const id = +b.dataset.id;
        const issue = issues.find(x => x.id === id);
        if (!issue) return;
        const def = (CORE.aiPromptDefaults ? CORE.aiPromptDefaults(issue, false) : {audience:'', constraints:''});
        if (aiByIssue[id]) {
          aiByIssue[id].editAudience = def.audience;
          aiByIssue[id].editConstraints = def.constraints;
          aiByIssue[id].editExtra = '';
        }
        renderBody();
      };
    });
    // Bouton « Annuler » — sort du mode édition sans envoyer
    body.querySelectorAll('[data-ai-action="cancel-edit"]').forEach(b => {
      b.onclick = (e) => {
        e.stopPropagation();
        const id = +b.dataset.id;
        if (aiByIssue[id]) aiByIssue[id].editingPrompt = false;
        if (aiByIssue[id] && !aiByIssue[id].options && !aiByIssue[id].error && !aiByIssue[id].needsConfig) delete aiByIssue[id];
        renderBody();
      };
    });
    // Bouton « Ouvrir la page de config » (cas needs_config en mode injection)
    body.querySelectorAll('[data-ai-action="open-config"]').forEach(b => {
      b.onclick = (e) => {
        e.stopPropagation();
        window.open('http://localhost:8080/', '_blank');
      };
    });
    // Bouton « Copier » d'une option IA
    body.querySelectorAll('[data-ai-action="copy"]').forEach(b => {
      b.onclick = (e) => {
        e.stopPropagation();
        const txt = b.dataset.text || '';
        try {
          navigator.clipboard.writeText(txt).then(() => {
            const orig = b.textContent;
            b.textContent = '✓ Copié'; b.disabled = true;
            setTimeout(() => { b.textContent = orig; b.disabled = false; }, 1500);
          });
        } catch(_) { alert('Copie refusée — sélectionnez manuellement.'); }
      };
    });
  }

  // Construit le bloc « Suggestions IA » d'une issue donnée selon son état (init/loading/needs_config/error/options/edit)
  function renderAISection(i) {
    const st = aiByIssue[i.id];
    const L = (CORE.aiUILabels ? CORE.aiUILabels(i) : {action:"Demander 3 suggestions IA",regen:"Régénérer",hint:"L'IA propose 3 alternatives (~5s).",empty:"suggestion"});
    // Mode édition du prompt — formulaire structuré (champs simples, format JSON caché)
    if (st && st.editingPrompt) {
      const def = (CORE.aiPromptDefaults ? CORE.aiPromptDefaults(i, false) : {audience:'', constraints:''});
      const audience = escapeHtml(st.editAudience != null ? st.editAudience : def.audience);
      const constraints = escapeHtml(st.editConstraints != null ? st.editConstraints : def.constraints);
      const extra = escapeHtml(st.editExtra || '');
      // Bloc lecture seule (info que l'IA verra mais que l'agent ne modifie pas)
      const sourceContent = i.sourceText || i.element || i.code || '';
      const sourceLabel = i.sourceText ? 'Texte à transformer' : (i.code ? 'Code HTML concerné' : 'Élément');
      return `<div class="ai-section"><div class="ai-section-label">💬 Suggestions IA — Personnaliser la demande</div>
        <div class="ai-edit-readonly-block">
          <div class="ai-edit-readonly-row"><span class="ai-edit-rolabel">Problème</span><div class="ai-edit-rovalue">${escapeHtml(i.message)}</div></div>
          ${i.context ? `<div class="ai-edit-readonly-row"><span class="ai-edit-rolabel">Contexte</span><div class="ai-edit-rovalue">${escapeHtml(i.context)}</div></div>` : ''}
          ${sourceContent ? `<div class="ai-edit-readonly-row"><span class="ai-edit-rolabel">${escapeHtml(sourceLabel)}</span><div class="ai-edit-rovalue ai-edit-rosource">${escapeHtml(sourceContent.substring(0,400))}${sourceContent.length>400?'…':''}</div></div>` : ''}
        </div>
        <div class="ai-edit-field">
          <label class="ai-edit-label">Public cible</label>
          <input class="ai-edit-input" type="text" data-edit-field="audience" data-id="${i.id}" value="${audience}">
        </div>
        <div class="ai-edit-field">
          <label class="ai-edit-label">Contraintes / style</label>
          <textarea class="ai-edit-textarea" data-edit-field="constraints" data-id="${i.id}" rows="3">${constraints}</textarea>
        </div>
        <div class="ai-edit-field">
          <label class="ai-edit-label">Instructions complémentaires <span class="ai-edit-hint">(optionnel)</span></label>
          <textarea class="ai-edit-textarea" data-edit-field="extra" data-id="${i.id}" rows="2" placeholder="Ex : « Une option formelle et une option familière »">${extra}</textarea>
        </div>
        <div class="ai-edit-actions">
          <button class="btn-ai-issue" data-ai-action="send-edited" data-id="${i.id}">✨ Envoyer</button>
          <button class="ai-edit-icon-btn" data-ai-action="reset-prompt" data-id="${i.id}" title="Réinitialiser aux valeurs par défaut">↺</button>
          <button class="ai-edit-cancel" data-ai-action="cancel-edit" data-id="${i.id}">Annuler</button>
        </div>
      </div>`;
    }
    if (!st) {
      return `<div class="ai-section"><div class="ai-section-label">💬 Suggestions IA</div><button class="btn-ai-issue" data-ai-action="suggest" data-id="${i.id}">✨ ${escapeHtml(L.action)}</button><div style="display:flex;gap:6px;margin-top:6px"><button class="btn-ai-edit-prompt" data-ai-action="edit-prompt" data-id="${i.id}" title="Voir et modifier le prompt envoyé à l'IA avant de l'envoyer">✏️ Voir / modifier le prompt</button></div><div class="ai-hint">${escapeHtml(L.hint)}</div></div>`;
    }
    if (st.loading) {
      return `<div class="ai-section"><div class="ai-section-label">💬 Suggestions IA</div><div class="ai-loading"><span class="ai-spinner"></span> ${escapeHtml(L.action.replace(/^(Suggérer|Demander|Générer) /, ''))} en cours…</div></div>`;
    }
    if (st.needsConfig) {
      // Mode injection : on ne peut pas ouvrir le settings modal du standalone depuis SP.
      // → Bouton qui ouvre http://localhost:8080/ dans un nouvel onglet pour la config.
      return `<div class="ai-section"><div class="ai-section-label">💬 Suggestions IA</div><div class="ai-error" style="background:#E7F0FF;border-color:#3B7CEB;color:#1E3F8A"><strong>⚙️ Configuration requise</strong>${escapeHtml(st.configMessage||'Token IA non configuré')}</div><button class="btn-ai-issue" data-ai-action="open-config">⚙️ Ouvrir la page de config</button><div class="ai-hint">Une fois le token saisi sur la page audit complète, revenez ici et cliquez « ↻ Réessayer ».</div><button class="btn-ai-issue" style="margin-top:6px;background:transparent;color:#3B7CEB;border:1px solid #3B7CEB" data-ai-action="suggest" data-id="${i.id}">↻ Réessayer</button></div>`;
    }
    if (st.error) {
      return `<div class="ai-section"><div class="ai-section-label">💬 Suggestions IA</div><div class="ai-error"><strong>❌ Échec</strong>${escapeHtml(st.error)}</div><div style="display:flex;gap:6px"><button class="btn-ai-issue" data-ai-action="suggest" data-id="${i.id}" style="flex:1">↻ Réessayer</button><button class="btn-ai-edit-prompt" data-ai-action="edit-prompt" data-id="${i.id}">✏️ Modifier le prompt</button></div></div>`;
    }
    if (st.options) {
      const visionBadge = st.visionUsed ? ' <span style="font-size:9px;font-weight:700;color:#fff;background:#8E4EC6;padding:2px 6px;border-radius:99px;text-transform:none;letter-spacing:.02em" title="L\'IA a analysé visuellement l\'image">👁️ VISION</span>' : '';
      const opts = st.options.map((o, idx) => `<div class="ai-option"><div class="ai-option-num">${idx+1}</div><div><div class="ai-option-text">${escapeHtml(o.texte)}</div>${o.note?'<div class="ai-option-note">'+escapeHtml(o.note)+'</div>':''}</div><button class="ai-option-copy" data-ai-action="copy" data-text="${escapeHtml(o.texte)}">📋 Copier</button></div>`).join('');
      return `<div class="ai-section"><div class="ai-section-label">💬 Suggestions IA <span style="font-size:10px;font-weight:600;color:var(--fg-3);text-transform:none;letter-spacing:0">${st.options.length} option${st.options.length>1?'s':''}</span>${visionBadge}</div>${opts}<div style="display:flex;gap:6px;margin-top:6px"><button class="btn-ai-issue" data-ai-action="suggest" data-id="${i.id}" style="flex:1">↻ ${escapeHtml(L.regen)}</button><button class="btn-ai-edit-prompt" data-ai-action="edit-prompt" data-id="${i.id}">✏️ Modifier le prompt</button></div></div>`;
    }
    return '';
  }

  // Déclenche un appel IA pour l'issue donnée et re-render à chaque étape.
  // promptOrOverrides : soit un object {audience, constraints, extra} (mode édition structurée),
  // soit un string brut (legacy), soit undefined (prompt par défaut).
  async function aiSuggestForIssue(id, promptOrOverrides) {
    const issue = issues.find(x => x.id === id);
    if (!issue) return;
    const prev = aiByIssue[id] || {};
    // On préserve les éditions pour qu'elles soient ré-éditables ensuite
    aiByIssue[id] = {
      loading: true, options: null, error: null,
      editAudience: prev.editAudience,
      editConstraints: prev.editConstraints,
      editExtra: prev.editExtra,
    };
    renderBody();
    let res;
    if (!CORE.aiReformulate) {
      res = {error: 'unavailable', message: "Fonction IA absente du bundle. Redémarrez start.py."};
    } else {
      res = await CORE.aiReformulate(issue, promptOrOverrides);
    }
    // Préserve les éditions pour qu'elles soient retrouvées au prochain « ✏️ Modifier »
    const carry = aiByIssue[id] || {};
    const carryFields = {
      editAudience: carry.editAudience,
      editConstraints: carry.editConstraints,
      editExtra: carry.editExtra,
    };
    if (res.error === 'needs_config') {
      aiByIssue[id] = Object.assign({loading: false, options: null, error: null, needsConfig: true, configMessage: res.message}, carryFields);
    } else if (res.error) {
      aiByIssue[id] = Object.assign({loading: false, options: null, error: res.message || res.error}, carryFields);
    } else {
      aiByIssue[id] = Object.assign({loading: false, options: res.options, error: null, visionUsed: !!res.visionUsed}, carryFields);
    }
    renderBody();
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  // 6. ─── PINS + HIGHLIGHTS ─────────────────────────────────────
  const pinsLayer = document.createElement('div');
  pinsLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none';
  shadow.appendChild(pinsLayer);
  const tooltip = document.createElement('div');
  tooltip.className = 'tooltip';
  shadow.appendChild(tooltip);
  let pinElems = [];

  function getElForIssue(i) {
    if (!i.targetId) return null;
    return document.querySelector(`[data-audit-id="${i.targetId}"]`);
  }

  // Détecte les zones de chrome SP (barre noire fixe en haut, footer) pour clipper
  // les pins/highlights afin qu'ils ne débordent pas dessus.
  // Stratégie : on cherche les éléments [position:fixed|sticky] qui collent au top=0 ou bottom=vh.
  function getClipBox() {
    const vw = window.innerWidth, vh = window.innerHeight;
    let top = 0, bottom = vh;
    const cand = 'header,[role="banner"],[data-automation-id="SuiteNavWrapper"],#SuiteNavWrapper,#spoSuiteNav,[data-automation-id="siteHeader"],#spSiteHeader,.sp-AppHeader,footer,[role="contentinfo"],[data-automation-id="pageFooter"]';
    document.querySelectorAll(cand).forEach(el => {
      if (el === host || host.contains(el)) return;
      let cs; try { cs = getComputedStyle(el); } catch(_) { return; }
      const stuck = cs.position === 'fixed' || cs.position === 'sticky';
      if (!stuck) return;
      const r = el.getBoundingClientRect();
      if (r.width < vw * 0.5) return;
      // Collé en haut
      if (r.top <= 1 && r.bottom < 200 && r.bottom > top) top = r.bottom;
      // Collé en bas
      if (r.bottom >= vh - 1 && r.top > vh - 300 && r.top < bottom) bottom = r.top;
    });
    return {top, bottom};
  }

  function renderPins() {
    // Remove previous
    pinElems.forEach(p => p.remove());
    pinElems = [];
    // Pins masqués par l'utilisateur (bouton 👁 du header) → on ne dessine rien
    if (!pinsVisible) return;
    // En mode édition SP, on essaie quand même de dessiner — retagDOMFromIssues a re-attribué
    // les data-audit-id aux éléments matchables (par src image, href lien, texte titre, etc.).
    // Les findings non retrouvés (rare) n'auront juste pas de pin.
    const vw = window.innerWidth, vh = window.innerHeight;
    const clip = getClipBox();
    // Rect du panneau visible (pour décaler les pins qui tomberaient dessous)
    const panelRect = (panel.classList.contains('collapsed') || host.style.display === 'none')
      ? null
      : panel.getBoundingClientRect();
    issues.filter(isVisible).forEach(i => {
      const el = getElForIssue(i);
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      // Hors viewport (avec marge)
      if (r.bottom < -100 || r.top > vh + 100 || r.right < -100 || r.left > vw + 100) return;
      // Entièrement masqué par chrome SP (header fixe ou footer) → on ne dessine pas
      if (r.bottom <= clip.top || r.top >= clip.bottom) return;
      // Highlight clippé pour ne pas déborder sur le chrome SP
      const hlTop = Math.max(r.top - 4, clip.top);
      const hlBottom = Math.min(r.bottom + 4, clip.bottom);
      const hl = document.createElement('div');
      hl.className = 'hl' + (i.id === activeId ? ' active' : '');
      hl.dataset.sev = i.severity;
      hl.style.cssText = `left:${r.left-4}px;top:${hlTop}px;width:${Math.max(r.width,12)+8}px;height:${Math.max(hlBottom-hlTop,12)}px`;
      pinsLayer.appendChild(hl);
      pinElems.push(hl);
      // Pin numéroté — position par défaut : à droite de l'élément
      let pinX = Math.min(vw - 30, r.right - 8);
      let pinY = Math.min(clip.bottom - 14, Math.max(clip.top + 14, r.top + 8));
      // Si le panneau couvre cette position, décaler le pin juste à gauche du panneau
      // pour qu'il reste cliquable et visible (sinon il finit caché dessous).
      if (panelRect && pinX >= panelRect.left - 8 && pinX <= panelRect.right + 8
          && pinY >= panelRect.top - 8 && pinY <= panelRect.bottom + 8) {
        pinX = Math.max(20, panelRect.left - 18);
      }
      const pin = document.createElement('button');
      pin.className = 'pin' + (i.id === activeId ? ' active' : '');
      pin.dataset.sev = i.severity;
      pin.dataset.id = i.id;
      pin.textContent = i.id;
      pin.style.left = pinX + 'px';
      pin.style.top = pinY + 'px';
      pin.onclick = (e) => { e.stopPropagation(); setActive(i.id); };
      pin.onmouseenter = () => showTooltip(pin, i);
      pin.onmouseleave = () => hideTooltip();
      pinsLayer.appendChild(pin);
      pinElems.push(pin);
    });
  }

  function showTooltip(pin, i) {
    tooltip.innerHTML = `<span class="sev" data-sev="${i.severity}">${CORE.SEV[i.severity]}</span><strong>${escapeHtml(i.message)}</strong>`;
    const r = pin.getBoundingClientRect();
    tooltip.style.left = (r.right + 8) + 'px';
    tooltip.style.top = r.top + 'px';
    tooltip.classList.add('show');
  }
  function hideTooltip() { tooltip.classList.remove('show'); }

  function setActive(id) {
    activeId = id;
    renderBody();
    renderPins();
    if (id == null) return;
    const i = issues.find(x => x.id === id);
    const el = i && getElForIssue(i);
    if (el) {
      el.scrollIntoView({behavior:'smooth', block:'center'});
      // Re-render pins après scroll
      setTimeout(renderPins, 400);
    }
  }

  // 7. ─── INTERACTIONS PANNEAU ──────────────────────────────────
  shadow.querySelectorAll('.panel-tab').forEach(t => {
    t.onclick = () => {
      activeTab = t.dataset.tab;
      shadow.querySelectorAll('.panel-tab').forEach(x => x.classList.toggle('active', x.dataset.tab === activeTab));
      renderBody();
    };
  });
  shadow.querySelector('.panel-collapse').onclick = () => {
    panel.classList.toggle('collapsed');
    // En mode docked : ajuste body margin à 56px (collapsed) ou 420px (étendu) pour que
    // le contenu SP retrouve sa place quand le panneau est réduit.
    if (dockMode === 'docked') {
      const w = panel.classList.contains('collapsed') ? 56 : PANEL_DOCKED_WIDTH;
      document.body.style.marginRight = w + 'px';
      document.body.style.width = 'calc(100vw - ' + w + 'px)';
      try { window.dispatchEvent(new Event('resize')); } catch(_) {}
    }
    renderPins();
  };
  shadow.querySelector('.panel-close').onclick = () => {
    // 1) Désactive observers pour qu'ils n'essaient pas de ré-attacher le host
    userClosed = true;
    try { if (bodyObserver) bodyObserver.disconnect(); } catch(_) {}
    try { if (docObserver) docObserver.disconnect(); } catch(_) {}
    // 2) Restaure le layout body de SP (rétabli son margin/width d'origine)
    restoreBodyStyles();
    // 3) Retire le host et reset le flag global → re-clic du favori re-injecte proprement
    host.remove();
    window.__AUDIT_INJECTOR_LOADED__ = false;
    window.__AUDIT_INJECTOR_TOGGLE__ = null;
  };
  shadow.querySelector('.panel-dock').onclick = () => {
    applyDockMode(dockMode === 'docked' ? 'floating' : 'docked');
  };

  // Bouton 👁 — masque / réaffiche les repères (pins + surlignages) sur la page
  shadow.querySelector('.panel-pins').onclick = () => {
    pinsVisible = !pinsVisible;
    const b = shadow.querySelector('.panel-pins');
    b.textContent = pinsVisible ? '👁' : '🙈';
    b.classList.toggle('off', !pinsVisible);
    b.title = pinsVisible ? 'Masquer les repères sur la page' : 'Afficher les repères sur la page';
    renderPins();
  };

  // ─── VÉRIFICATION DES MISES À JOUR (depuis le panneau) ──────────
  // Le panneau tourne sur sharepoint.com : on passe par le serveur local (localhost est
  // exempté du blocage mixed-content) qui proxie l'API GitHub Releases et expose la version.
  const SERVER = 'http://localhost:8080';
  const UPDATE_API = 'https://api.github.com/repos/Fijaos-Fif/Sharepoint-Accessibility-inspector/releases/latest';
  function cmpVer(a, b) {
    const pa = String(a||'0').split('.').map(n => parseInt(n)||0);
    const pb = String(b||'0').split('.').map(n => parseInt(n)||0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i]||0) - (pb[i]||0);
      if (d) return d;
    }
    return 0;
  }
  function showToast(msg, kind) {
    const old = shadow.querySelector('.a-toast');
    if (old) old.remove();
    const t = document.createElement('div');
    t.className = 'a-toast' + (kind ? ' ' + kind : '');
    t.textContent = msg;
    shadow.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; }, 5000);
    setTimeout(() => { t.remove(); }, 5400);
  }
  // Renvoie {local, latest} ou null si indisponible
  async function fetchUpdateInfo() {
    let local = null;
    try { const r = await fetch(SERVER + '/api/version', {cache:'no-store'}); if (r.ok) local = (await r.json()).version; } catch(_) {}
    let data = null;
    try { const r = await fetch(SERVER + '/api/check-update?url=' + encodeURIComponent(UPDATE_API), {cache:'no-store'}); if (r.ok) data = await r.json(); } catch(_) {}
    if (!data) { try { const r = await fetch(UPDATE_API, {cache:'no-store'}); if (r.ok) data = await r.json(); } catch(_) {} }
    if (data && data.tag_name) data = { version: String(data.tag_name).replace(/^v/, '') };
    if (!local || !data || !data.version) return null;
    return { local, latest: data.version };
  }
  shadow.querySelector('#checkUpdate').onclick = async () => {
    const btn = shadow.querySelector('#checkUpdate');
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = '⏳ Vérification…';
    const info = await fetchUpdateInfo();
    btn.disabled = false; btn.textContent = orig;
    if (!info) { showToast('⚠ Impossible de vérifier les mises à jour. Vérifiez que l\'outil est bien démarré (fenêtre « Démarrer ») et réessayez.', 'warn'); return; }
    if (cmpVer(info.latest, info.local) > 0) {
      showToast('🚀 Mise à jour disponible : v' + info.latest + ' (vous avez v' + info.local + '). Pour l\'installer : fermez l\'outil et relancez « Démarrer » — l\'installation est proposée au démarrage.', 'update');
    } else {
      showToast('✓ Vous êtes à jour (v' + info.local + ').', 'ok');
    }
  };
  // Auto-check discret au chargement : surligne le bouton si une MAJ existe (best-effort, silencieux)
  fetchUpdateInfo().then(info => {
    if (info && cmpVer(info.latest, info.local) > 0) {
      const btn = shadow.querySelector('#checkUpdate');
      btn.classList.add('has-update');
      btn.textContent = '🚀 Mise à jour disponible (v' + info.latest + ')';
    }
  }).catch(() => {});

  // Relancer l'audit RAPIDE — approche D (mini pre-scan)
  // Ouvre les sections refermées par l'agent depuis le dernier audit, attend 600ms, puis audite.
  // Ne scroll PAS les WebParts (déjà chargés au 1er audit). Pas d'overlay bloquant.
  // Pour un cas où un nouveau WebPart vient d'être ajouté ou la page a beaucoup changé :
  // utiliser « 🔍 Re-scan complet » dans le footer (approche A, full pre-scan).
  shadow.querySelector('.panel-rerun').onclick = async () => {
    const btn = shadow.querySelector('.panel-rerun');
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.add('spinning');
    // Mini pre-scan : ouvre les sections collapsibles qui auraient été refermées
    await runMiniPreScan();
    let R2;
    try {
      R2 = CORE.runAudit(document);
    } catch(e) {
      btn.disabled = false;
      btn.classList.remove('spinning');
      alert("❌ Erreur pendant l'audit : " + e.message);
      return;
    }
    // Remplace le contenu de `issues` en place (les autres closures référencent ce tableau)
    issues.length = 0;
    for (const it of (R2.issues || [])) issues.push(it);
    // Restaure les flags persistés depuis localStorage (par signature stable)
    applyStoredFlagsToIssues(issues);
    // Recharge la hiérarchie des titres pour l'onglet Titres
    headings = R2.headings || [];
    // Reset de l'élément actif s'il n'existe plus → ferme toutes les cartes
    if (!issues.find(x => x.id === activeId && active(x))) {
      activeId = null;
    }
    renderHeadScore();
    renderBody();
    renderPins();
    btn.disabled = false;
    btn.classList.remove('spinning');
    console.log('[audit-injector] relance audit : %d problèmes actifs', issues.filter(active).length);
  };

  // ─── DRAG PANNEAU ───────────────────────────────────────────
  // mousedown sur la zone d'en-tête (mais pas sur ses boutons) → drag.
  // Au 1er drag, on bascule du positionnement top/right vers top/left absolu.
  const panelHead = shadow.querySelector('.panel-head');
  let drag = null;
  panelHead.addEventListener('mousedown', (e) => {
    // Drag actif uniquement en mode flottant (en mode docked, le panneau est fixé à droite)
    if (dockMode === 'docked') return;
    // Ignore clics sur les boutons de l'en-tête (collapse/close/dock)
    if (e.target.closest('button')) return;
    const r = panel.getBoundingClientRect();
    drag = {dx: e.clientX - r.left, dy: e.clientY - r.top};
    // Fixe la taille actuelle en left/top (libère right/bottom)
    panel.style.left = r.left + 'px';
    panel.style.top = r.top + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.height = r.height + 'px';
    panel.classList.add('dragging');
    e.preventDefault();
  });
  // mousemove/up sur document (capture car panel-head est dans le shadow root)
  document.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const w = panel.offsetWidth, h = panel.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    // Clamp : au moins 40px du head doit rester visible pour pouvoir re-drag
    const x = Math.max(8 - w + 80, Math.min(vw - 80, e.clientX - drag.dx));
    const y = Math.max(0, Math.min(vh - 40, e.clientY - drag.dy));
    panel.style.left = x + 'px';
    panel.style.top = y + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!drag) return;
    drag = null;
    panel.classList.remove('dragging');
    // Le panneau a bougé → les pins sous lui peuvent maintenant être ailleurs
    renderPins();
  });
  // Re-scan complet (approche A) : full pre-scan avec overlay + nouvel audit complet
  // Utile si l'agent a ajouté un WebPart, ou si la page a beaucoup changé depuis le dernier audit.
  shadow.querySelector('#fullRescan').onclick = async () => {
    const btn = shadow.querySelector('#fullRescan');
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = '🔍 Audit en cours…';
    try {
      await runFullPreScan();
      const R2 = CORE.runAudit(document);
      issues.length = 0;
      for (const it of (R2.issues || [])) issues.push(it);
      applyStoredFlagsToIssues(issues);
      headings = R2.headings || [];
      if (!issues.find(x => x.id === activeId && active(x))) activeId = null;
      renderHeadScore();
      renderBody();
      renderPins();
      console.log('[audit-injector] re-scan complet : %d problèmes actifs', issues.filter(active).length);
    } catch(e) {
      alert("❌ Erreur pendant le re-scan : " + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '🔍 Re-scan complet';
    }
  };

  shadow.querySelector('#openFull').onclick = () => {
    // Capture le HTML actuel et POST à start.py pour ouvrir l'audit complet
    const html = document.documentElement.outerHTML;
    const f = document.createElement('form');
    f.method = 'POST';
    f.action = 'http://localhost:8080/api/audit-html-form';
    f.target = '_blank';
    f.style.cssText = 'position:absolute;left:-9999px';
    const ta = document.createElement('textarea');
    ta.name = 'html'; ta.value = html;
    f.appendChild(ta);
    const s = document.createElement('input');
    s.type = 'hidden'; s.name = 'source'; s.value = location.href;
    f.appendChild(s);
    document.body.appendChild(f);
    f.submit();
    setTimeout(() => f.remove(), 2000);
  };

  // Toggle global (au cas où on re-clique le favori) : cache/montre + ajuste body styles
  window.__AUDIT_INJECTOR_TOGGLE__ = () => {
    if (host.style.display === 'none') {
      host.style.display = '';
      if (dockMode === 'docked') applyDockMode('docked');
    } else {
      host.style.display = 'none';
      restoreBodyStyles();
    }
  };

  // 8. ─── INITIAL RENDER ────────────────────────────────────────
  applyDockMode(dockMode);
  if (initialEditMode) {
    inEditMode = true;
    console.log('[audit-injector] démarré en mode édition SP — pins re-attachés par signature DOM');
  }
  renderBody();
  scheduleRetagAndRenderPins(); // retag + pins (couvre aussi le cas démarrage en édition)
  // Re-render au resize/scroll
  let raf = null;
  function scheduleRender() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = null; renderPins(); });
  }
  window.addEventListener('scroll', scheduleRender, {passive:true});
  window.addEventListener('resize', scheduleRender);
  document.addEventListener('scroll', scheduleRender, {passive:true, capture:true});
  // En mode édition SP, le contenu est souvent dans des containers internes scrollables
  // (CKEditor, panneaux SP, etc.) dont les events scroll ne bubblent pas. On attache un listener
  // sur chacun pour que les pins suivent l'élément quand l'utilisateur scrolle dans ces zones.
  // Réattaché périodiquement (10s) au cas où SP créerait de nouveaux containers en édition.
  const attachedScrollContainers = new WeakSet();
  function attachScrollListenersToInnerContainers() {
    try {
      const all = document.querySelectorAll('*');
      let attached = 0;
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        if (attachedScrollContainers.has(el)) continue;
        let s; try { s = getComputedStyle(el); } catch(_) { continue; }
        if ((s.overflowY === 'auto' || s.overflowY === 'scroll' || s.overflowX === 'auto' || s.overflowX === 'scroll')
            && (el.scrollHeight > el.clientHeight + 5 || el.scrollWidth > el.clientWidth + 5)) {
          el.addEventListener('scroll', scheduleRender, {passive: true});
          attachedScrollContainers.add(el);
          attached++;
        }
      }
      if (attached > 0) console.log('[audit-injector] scroll listeners attachés à', attached, 'container(s) interne(s)');
    } catch(e) { console.warn('[audit-injector] attach scroll listeners error:', e); }
  }
  attachScrollListenersToInnerContainers();
  setInterval(attachScrollListenersToInnerContainers, 10000);
  // IntersectionObserver : détecte quand un élément tagué passe la frontière du viewport.
  // Observe aussi les images SP par data-sp-originalimgsrc (même sans tag) : SP fait du lazy
  // loading et certaines images ne sont rendues qu'à l'arrivée dans le viewport.
  // Quand une image apparaît → on déclenche un retag pour qu'elle reçoive son data-audit-id.
  try {
    const io = new IntersectionObserver(() => {
      // Si une image vient d'apparaître, elle peut maintenant être taguée → retag + render
      scheduleRetagAndRenderPins();
    }, {root: null, rootMargin: '300px'});
    setInterval(() => {
      try {
        const tagged = document.querySelectorAll('[data-audit-id]');
        const lazyImgs = document.querySelectorAll('img[data-sp-originalimgsrc]:not([data-audit-id])');
        tagged.forEach(el => io.observe(el));
        lazyImgs.forEach(el => io.observe(el));
      } catch(_) {}
    }, 3000);
  } catch(_) {}

  console.log('[audit-injector] %d problèmes détectés, score %d/100', activeCount, score);
})();
