/* ============================================================
   OM SHAH — EMI Calculator & Loan Analysis Dashboard
   script.js — full application logic
============================================================ */
(function () {
  'use strict';

  /* ============================================================
     CONSTANTS & STATE
  ============================================================ */
  const CURRENCY_SYMBOLS = { INR: '₹', USD: '$', EUR: '€', GBP: '£' };
  const CURRENCY_LOCALE  = { INR: 'en-IN', USD: 'en-US', EUR: 'de-DE', GBP: 'en-GB' };

  const appState = {
    currency: 'INR',
    theme: 'light',
    principal: 2500000,
    rate: 8.5,
    tenureMonths: 240,
    schedule: [],
    emi: 0
  };

  const charts = { line: null, doughnut: null, area: null, bar: null };
  let amortController = null;
  let repayController = null;
  let recalcTimer = null;

  /* ============================================================
     DOM HELPERS
  ============================================================ */
  function $(id) { return document.getElementById(id); }
  function $$(sel) { return Array.from(document.querySelectorAll(sel)); }

  function debounce(fn, wait) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(null, args), wait);
    };
  }

  function clamp(v, min, max) {
    const n = parseFloat(v);
    const lo = parseFloat(min);
    const hi = parseFloat(max);
    if (isNaN(n)) return lo;
    return Math.min(Math.max(n, lo), hi);
  }

  function parseNumber(str) {
    const v = parseFloat(String(str).replace(/,/g, ''));
    return isNaN(v) ? 0 : v;
  }

  function round2(n) { return Math.round(n * 100) / 100; }

  function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); }

  function setError(id, msg) { const el = $(id); if (el) el.textContent = msg; }
  function clearError(id) { const el = $(id); if (el) el.textContent = ''; }

  /* ============================================================
     TOASTS
  ============================================================ */
  function showToast(message, type, icon) {
    type = type || 'info';
    const container = $('toastContainer');
    if (!container) return;
    const icons = {
      success: 'fa-circle-check',
      error: 'fa-circle-exclamation',
      warning: 'fa-triangle-exclamation',
      info: 'fa-circle-info'
    };
    const div = document.createElement('div');
    div.className = 'toast ' + type;
    div.innerHTML = '<i class="fa-solid ' + (icon || icons[type] || icons.info) + '"></i><span>' + message + '</span>';
    container.appendChild(div);
    setTimeout(() => {
      div.classList.add('hide');
      setTimeout(() => div.remove(), 350);
    }, 3200);
  }

  /* ============================================================
     LOADER
  ============================================================ */
  function hideLoader() {
    const loader = $('pageLoader');
    if (loader) loader.classList.add('hidden');
  }

  /* ============================================================
     THEME
  ============================================================ */
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    appState.theme = theme;
    const icon = $('themeToggle') ? $('themeToggle').querySelector('i') : null;
    if (icon) icon.className = theme === 'dark' ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
    try { localStorage.setItem('emiTheme', theme); } catch (e) { /* ignore */ }
  }

  function toggleTheme() {
    applyTheme(appState.theme === 'dark' ? 'light' : 'dark');
    refreshChartThemeColors();
  }

  function refreshChartThemeColors() {
    Object.keys(charts).forEach(k => {
      if (charts[k]) { charts[k].destroy(); charts[k] = null; }
    });
    updateCharts();
  }

  /* ============================================================
     CURRENCY
  ============================================================ */
  function formatMoney(value) {
    if (value === null || value === undefined || isNaN(value)) value = 0;
    try {
      return new Intl.NumberFormat(CURRENCY_LOCALE[appState.currency] || 'en-US', {
        style: 'currency',
        currency: appState.currency,
        maximumFractionDigits: 0
      }).format(value);
    } catch (e) {
      return (CURRENCY_SYMBOLS[appState.currency] || '') + Math.round(value).toLocaleString();
    }
  }

  function compactMoney(v) {
    const sym = CURRENCY_SYMBOLS[appState.currency] || '';
    const abs = Math.abs(v);
    if (abs >= 1e7) return sym + (v / 1e7).toFixed(1) + 'Cr';
    if (abs >= 1e5) return sym + (v / 1e5).toFixed(1) + 'L';
    if (abs >= 1e3) return sym + (v / 1e3).toFixed(1) + 'K';
    return sym + Math.round(v);
  }

  function onCurrencyChange(e) {
    appState.currency = e.target.value;
    const prefixEl = $('currencyPrefix');
    if (prefixEl) prefixEl.textContent = CURRENCY_SYMBOLS[appState.currency];
    $$('#goalSeekForm .prefix').forEach(el => { el.textContent = CURRENCY_SYMBOLS[appState.currency]; });
    try { localStorage.setItem('emiCurrency', appState.currency); } catch (e2) { /* ignore */ }
    refreshAllDisplays();
    showToast('Currency changed to ' + appState.currency, 'info');
  }

  function restorePrefs() {
    let theme = 'light';
    let currency = 'INR';
    try {
      theme = localStorage.getItem('emiTheme') || 'light';
      currency = localStorage.getItem('emiCurrency') || 'INR';
    } catch (e) { /* ignore */ }
    applyTheme(theme);
    appState.currency = currency;
    const selector = $('currencySelector');
    if (selector) selector.value = currency;
    const prefixEl = $('currencyPrefix');
    if (prefixEl) prefixEl.textContent = CURRENCY_SYMBOLS[currency];
    $$('#goalSeekForm .prefix').forEach(el => { el.textContent = CURRENCY_SYMBOLS[currency]; });
  }

  /* ============================================================
     EMI MATH
  ============================================================ */
  function computeEMI(P, annualRatePct, months) {
    const r = annualRatePct / 1200;
    if (r <= 0) return P / months;
    const factor = Math.pow(1 + r, months);
    return (P * r * factor) / (factor - 1);
  }

  function generateAmortization(P, annualRatePct, months) {
    const r = annualRatePct / 1200;
    const emi = computeEMI(P, annualRatePct, months);
    let balance = P;
    const rows = [];
    for (let i = 1; i <= months; i++) {
      const interest = balance * r;
      let principalPaid = emi - interest;
      let closing = balance - principalPaid;
      if (i === months || closing < 0.5) {
        principalPaid = balance;
        closing = 0;
      }
      rows.push({
        no: i,
        opening: round2(balance),
        emi: round2(principalPaid + interest),
        interest: round2(interest),
        principal: round2(principalPaid),
        closing: round2(closing)
      });
      balance = closing;
    }
    return rows;
  }

  /* ============================================================
     MAIN CALCULATE
  ============================================================ */
  function calculate(silent) {
    const P = parseNumber($('principal').value);
    const annualRate = parseFloat($('rate').value);
    const tenureVal = parseFloat($('tenure').value);
    const unit = $('tenureUnit').value;
    const months = unit === 'years' ? Math.round(tenureVal * 12) : Math.round(tenureVal);

    let valid = true;
    if (!(P > 0)) { setError('principalError', 'Enter a valid principal amount'); valid = false; }
    else clearError('principalError');

    if (!(annualRate >= 0 && annualRate <= 100)) { setError('rateError', 'Rate should be between 0 and 100'); valid = false; }
    else clearError('rateError');

    if (!(months >= 1 && months <= 600)) { setError('tenureError', 'Tenure should be between 1 month and 50 years'); valid = false; }
    else clearError('tenureError');

    if (!valid) {
      if (!silent) showToast('Please fix the highlighted fields', 'error');
      return;
    }

    appState.principal = P;
    appState.rate = annualRate;
    appState.tenureMonths = months;

    const schedule = generateAmortization(P, annualRate, months);
    appState.schedule = schedule;
    appState.emi = schedule.length ? (schedule[0].principal + schedule[0].interest) : 0;

    renderRateStrip();
    renderKPIs();
    renderSummary();
    renderRepaySummary();
    if (amortController) amortController.setData(schedule);
    if (repayController) repayController.setData(schedule);
    updateCharts();

    if (!silent) showToast('EMI recalculated', 'success');
  }

  function scheduleRecalc() {
    clearTimeout(recalcTimer);
    recalcTimer = setTimeout(() => calculate(true), 300);
  }

  function refreshAllDisplays() {
    renderRateStrip();
    renderKPIs();
    renderSummary();
    renderRepaySummary();
    if (amortController) amortController.rerender();
    if (repayController) repayController.rerender();
    updateCharts();
  }

  /* ============================================================
     RENDER — RATE STRIP / KPI / SUMMARY
  ============================================================ */
  function renderRateStrip() {
    const monthlyRate = appState.rate / 12;
    const dailyInterest = (appState.principal * (appState.rate / 100)) / 365;
    $('stripMonthlyEmi').textContent = formatMoney(appState.emi);
    $('stripYearlyEmi').textContent = formatMoney(appState.emi * 12);
    $('stripMonthlyRate').textContent = monthlyRate.toFixed(4) + '%';
    $('stripAnnualRate').textContent = appState.rate.toFixed(2) + '%';
    $('stripDailyInterest').textContent = formatMoney(dailyInterest);
  }

  function renderKPIs() {
    const P = appState.principal;
    const schedule = appState.schedule;
    const months = appState.tenureMonths;
    const totalPayment = schedule.reduce((s, r) => s + r.emi, 0);
    const totalInterest = totalPayment - P;

    const cards = [
      { icon: 'fa-money-bill-wave', label: 'Monthly EMI', value: formatMoney(appState.emi) },
      { icon: 'fa-sack-dollar', label: 'Total Interest', value: formatMoney(totalInterest) },
      { icon: 'fa-coins', label: 'Total Payment', value: formatMoney(totalPayment) },
      { icon: 'fa-calendar-days', label: 'Tenure', value: months + ' months (' + (months / 12).toFixed(1) + ' yrs)', alt: true },
      { icon: 'fa-percent', label: 'Interest / Principal', value: (P > 0 ? ((totalInterest / P) * 100).toFixed(1) : '0') + '%' }
    ];

    $('kpiGrid').innerHTML = cards.map((c, i) =>
      '<div class="kpi-card' + (c.alt ? ' alt' : '') + '" style="animation-delay:' + (i * 70) + 'ms">' +
      '<i class="fa-solid ' + c.icon + ' kpi-icon"></i>' +
      '<div class="kpi-label">' + c.label + '</div>' +
      '<div class="kpi-value">' + c.value + '</div>' +
      '</div>'
    ).join('');
  }

  function renderSummary() {
    const schedule = appState.schedule;
    const P = appState.principal;
    const totalPayment = schedule.reduce((s, r) => s + r.emi, 0);
    const totalInterest = totalPayment - P;

    const items = [
      { label: 'Principal Amount', value: formatMoney(P) },
      { label: 'Total Interest', value: formatMoney(totalInterest) },
      { label: 'Total Payment', value: formatMoney(totalPayment) },
      { label: 'Number of EMIs', value: schedule.length }
    ];
    $('summaryGrid').innerHTML = items.map(i =>
      '<div class="summary-item"><span>' + i.label + '</span><strong>' + i.value + '</strong></div>'
    ).join('');

    const pPct = totalPayment > 0 ? (P / totalPayment) * 100 : 0;
    const iPct = 100 - pPct;
    $('principalPct').textContent = pPct.toFixed(1) + '%';
    $('interestPct').textContent = iPct.toFixed(1) + '%';
    requestAnimationFrame(() => {
      $('principalBar').style.width = pPct + '%';
      $('interestBar').style.width = iPct + '%';
    });
  }

  function renderRepaySummary() {
    const schedule = appState.schedule;
    const totalPayment = schedule.reduce((s, r) => s + r.emi, 0);
    const totalInterest = totalPayment - appState.principal;
    const items = [
      { label: 'Monthly EMI', value: formatMoney(appState.emi) },
      { label: 'Total Interest Payable', value: formatMoney(totalInterest) },
      { label: 'Total Amount Payable', value: formatMoney(totalPayment) },
      { label: 'Total Installments', value: schedule.length }
    ];
    $('repaySummaryGrid').innerHTML = items.map(i =>
      '<div class="summary-item"><span>' + i.label + '</span><strong>' + i.value + '</strong></div>'
    ).join('');
  }

  /* ============================================================
     GENERIC TABLE CONTROLLER (used for Amortization & Repayment)
  ============================================================ */
  function createTableController(cfg) {
    let fullData = [];
    let filtered = [];
    let sortKey = 'no';
    let sortDir = 1;
    let page = 1;
    let pageSize = 25;

    function setData(data) {
      fullData = data;
      applyFilterSort();
    }

    function applyFilterSort() {
      const searchEl = $(cfg.searchId);
      const term = searchEl ? searchEl.value.trim().toLowerCase() : '';
      filtered = !term ? fullData.slice() : fullData.filter(r =>
        String(r.no).includes(term) ||
        String(Math.round(r.emi)).includes(term) ||
        String(Math.round(r.interest)).includes(term) ||
        String(Math.round(r.principal)).includes(term) ||
        String(Math.round(r.opening)).includes(term) ||
        String(Math.round(r.closing)).includes(term)
      );
      filtered.sort((a, b) => (a[sortKey] - b[sortKey]) * sortDir);
      page = 1;
      render();
    }

    function render() {
      const body = $(cfg.bodyId);
      if (!body) return;
      let pageRows;
      let totalPages = 1;
      if (pageSize === 'all') {
        pageRows = filtered;
      } else {
        totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
        if (page > totalPages) page = totalPages;
        pageRows = filtered.slice((page - 1) * pageSize, page * pageSize);
      }

      if (pageRows.length === 0) {
        body.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-soft);">No matching records</td></tr>';
      } else {
        body.innerHTML = pageRows.map(r =>
          '<tr class="' + (r.no === fullData.length ? 'row-final' : '') + '">' +
          '<td>' + r.no + '</td>' +
          '<td>' + formatMoney(r.opening) + '</td>' +
          '<td>' + formatMoney(r.emi) + '</td>' +
          '<td>' + formatMoney(r.interest) + '</td>' +
          '<td>' + formatMoney(r.principal) + '</td>' +
          '<td>' + formatMoney(r.closing) + '</td>' +
          '</tr>'
        ).join('');
      }

      if (cfg.footId) {
        const foot = $(cfg.footId);
        if (foot) {
          const totalEmi = filtered.reduce((s, r) => s + r.emi, 0);
          const totalInt = filtered.reduce((s, r) => s + r.interest, 0);
          const totalPrin = filtered.reduce((s, r) => s + r.principal, 0);
          foot.innerHTML = '<tr><td>Total</td><td>—</td><td>' + formatMoney(totalEmi) +
            '</td><td>' + formatMoney(totalInt) + '</td><td>' + formatMoney(totalPrin) + '</td><td>—</td></tr>';
        }
      }
      renderPagination(totalPages);
    }

    function renderPagination(totalPages) {
      const pag = $(cfg.paginationId);
      if (!pag) return;
      if (pageSize === 'all') { pag.innerHTML = ''; return; }
      const windowSize = 2;
      let html = '<button class="page-btn" data-p="prev" ' + (page === 1 ? 'disabled' : '') + '><i class="fa-solid fa-chevron-left"></i></button>';
      for (let p = 1; p <= totalPages; p++) {
        if (p === 1 || p === totalPages || Math.abs(p - page) <= windowSize) {
          html += '<button class="page-btn ' + (p === page ? 'active' : '') + '" data-p="' + p + '">' + p + '</button>';
        } else if (Math.abs(p - page) === windowSize + 1) {
          html += '<span style="padding:0 4px;color:var(--text-soft)">…</span>';
        }
      }
      html += '<button class="page-btn" data-p="next" ' + (page === totalPages ? 'disabled' : '') + '><i class="fa-solid fa-chevron-right"></i></button>';
      pag.innerHTML = html;
      $$('#' + cfg.paginationId + ' .page-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const p = btn.dataset.p;
          if (p === 'prev') page = Math.max(1, page - 1);
          else if (p === 'next') page = Math.min(totalPages, page + 1);
          else page = parseInt(p, 10);
          render();
        });
      });
    }

    // Bind static events once
    const searchEl = $(cfg.searchId);
    if (searchEl) searchEl.addEventListener('input', debounce(applyFilterSort, 200));

    const pageSizeEl = $(cfg.pageSizeId);
    if (pageSizeEl) {
      pageSizeEl.addEventListener('change', e => {
        pageSize = e.target.value === 'all' ? 'all' : parseInt(e.target.value, 10);
        page = 1;
        render();
      });
    }

    $$('#' + cfg.tableId + ' thead th').forEach(th => {
      th.addEventListener('click', () => {
        const key = th.dataset.key;
        if (!key) return;
        if (sortKey === key) sortDir *= -1; else { sortKey = key; sortDir = 1; }
        applyFilterSort();
      });
    });

    if (cfg.copyBtnId && $(cfg.copyBtnId)) $(cfg.copyBtnId).addEventListener('click', () => copyTableData(filtered, cfg.title));
    if (cfg.printBtnId && $(cfg.printBtnId)) $(cfg.printBtnId).addEventListener('click', () => printTableData(filtered, cfg.title));
    if (cfg.csvBtnId && $(cfg.csvBtnId)) $(cfg.csvBtnId).addEventListener('click', () => exportCsv(filtered, cfg.title));
    if (cfg.excelBtnId && $(cfg.excelBtnId)) $(cfg.excelBtnId).addEventListener('click', () => exportExcel(filtered, cfg.title));
    if (cfg.pdfBtnId && $(cfg.pdfBtnId)) $(cfg.pdfBtnId).addEventListener('click', () => exportPdf(filtered, cfg.title));

    return {
      setData: setData,
      getFiltered: () => filtered,
      rerender: render
    };
  }

  /* ============================================================
     EXPORT HELPERS (CSV / EXCEL / PDF / COPY / PRINT)
  ============================================================ */
  function downloadBlob(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  const EXPORT_HEADER = ['Payment No', 'Opening Balance', 'EMI', 'Interest', 'Principal', 'Closing Balance'];

  function exportCsv(rows, title) {
    if (!rows.length) { showToast('No data to export', 'warning'); return; }
    const lines = [EXPORT_HEADER.join(',')];
    rows.forEach(r => lines.push([r.no, round2(r.opening), round2(r.emi), round2(r.interest), round2(r.principal), round2(r.closing)].join(',')));
    downloadBlob(lines.join('\n'), slug(title) + '.csv', 'text/csv');
    showToast('CSV exported', 'success');
  }

  function exportExcel(rows, title) {
    if (!rows.length) { showToast('No data to export', 'warning'); return; }
    if (typeof XLSX === 'undefined') { showToast('Excel library not loaded', 'error'); return; }
    const aoa = [[title], [], EXPORT_HEADER].concat(
      rows.map(r => [r.no, round2(r.opening), round2(r.emi), round2(r.interest), round2(r.principal), round2(r.closing)])
    );
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Schedule');
    XLSX.writeFile(wb, slug(title) + '.xlsx');
    showToast('Excel file exported', 'success');
  }

  function exportPdf(rows, title) {
    if (!rows.length) { showToast('No data to export', 'warning'); return; }
    if (typeof window.jspdf === 'undefined') { showToast('PDF library not loaded', 'error'); return; }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    doc.setFontSize(14);
    doc.text(title, 14, 16);
    doc.autoTable({
      startY: 22,
      head: [EXPORT_HEADER],
      body: rows.map(r => [r.no, formatMoney(r.opening), formatMoney(r.emi), formatMoney(r.interest), formatMoney(r.principal), formatMoney(r.closing)]),
      styles: { fontSize: 8 },
      headStyles: { fillColor: [109, 40, 217] }
    });
    doc.save(slug(title) + '.pdf');
    showToast('PDF exported', 'success');
  }

  function copyTableData(rows, title) {
    if (!rows.length) { showToast('No data to copy', 'warning'); return; }
    const lines = [EXPORT_HEADER.join('\t')];
    rows.forEach(r => lines.push([r.no, round2(r.opening), round2(r.emi), round2(r.interest), round2(r.principal), round2(r.closing)].join('\t')));
    const text = lines.join('\n');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => showToast(title + ' copied to clipboard', 'success'))
        .catch(() => showToast('Copy failed — clipboard permission denied', 'error'));
    } else {
      showToast('Clipboard API not available', 'error');
    }
  }

  function printTableData(rows, title) {
    if (!rows.length) { showToast('No data to print', 'warning'); return; }
    const win = window.open('', '_blank');
    if (!win) { showToast('Please allow pop-ups to print', 'warning'); return; }
    const rowsHtml = rows.map(r =>
      '<tr><td>' + r.no + '</td><td>' + formatMoney(r.opening) + '</td><td>' + formatMoney(r.emi) +
      '</td><td>' + formatMoney(r.interest) + '</td><td>' + formatMoney(r.principal) + '</td><td>' + formatMoney(r.closing) + '</td></tr>'
    ).join('');
    win.document.write(
      '<html><head><title>' + title + '</title><style>' +
      'body{font-family:Arial,sans-serif;padding:24px;color:#111;}' +
      'h1{font-size:18px;}' +
      'table{width:100%;border-collapse:collapse;margin-top:12px;}' +
      'th,td{border:1px solid #ccc;padding:6px 10px;font-size:12px;text-align:left;}' +
      'th{background:#6D28D9;color:#fff;}' +
      'tr:nth-child(even){background:#f5f3ff;}' +
      '</style></head><body>' +
      '<h1>' + title + '</h1>' +
      '<table><thead><tr>' + EXPORT_HEADER.map(h => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>' + rowsHtml + '</tbody></table>' +
      '<script>window.onload=function(){window.print();};<' + '/script>' +
      '</body></html>'
    );
    win.document.close();
  }

  /* ============================================================
     CHARTS
  ============================================================ */
  function getChartColors() {
    const styles = getComputedStyle(document.documentElement);
    return {
      primary: styles.getPropertyValue('--primary').trim(),
      blue: styles.getPropertyValue('--blue').trim(),
      indigo: styles.getPropertyValue('--indigo').trim(),
      success: styles.getPropertyValue('--success').trim(),
      danger: styles.getPropertyValue('--danger').trim(),
      text: styles.getPropertyValue('--text').trim(),
      textMuted: styles.getPropertyValue('--text-muted').trim(),
      grid: styles.getPropertyValue('--border').trim()
    };
  }

  function hexToRgba(hex, alpha) {
    hex = (hex || '#6D28D9').replace('#', '').trim();
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    const bigint = parseInt(hex, 16);
    const r = (bigint >> 16) & 255, g = (bigint >> 8) & 255, b = bigint & 255;
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  function buildBuckets() {
    const schedule = appState.schedule;
    const months = schedule.length;
    const useYearly = months > 60;
    const buckets = [];
    if (useYearly) {
      const years = Math.ceil(months / 12);
      for (let y = 0; y < years; y++) {
        const slice = schedule.slice(y * 12, (y + 1) * 12);
        if (!slice.length) continue;
        buckets.push({
          label: 'Yr ' + (y + 1),
          principal: slice.reduce((s, r) => s + r.principal, 0),
          interest: slice.reduce((s, r) => s + r.interest, 0),
          closing: slice[slice.length - 1].closing
        });
      }
    } else {
      schedule.forEach(r => buckets.push({ label: '#' + r.no, principal: r.principal, interest: r.interest, closing: r.closing }));
    }
    return buckets;
  }

  function ensureChartHeights() {
    ['lineChart', 'doughnutChart', 'areaChart', 'barChart'].forEach(id => {
      const canvas = $(id);
      if (canvas) {
        canvas.style.height = '300px';
        canvas.style.width = '100%';
      }
    });
  }

  function baseLineOptions() {
    const colors = getChartColors();
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'bottom' } },
      scales: {
        x: { grid: { display: false } },
        y: { grid: { color: colors.grid }, ticks: { callback: v => compactMoney(v) } }
      }
    };
  }

  function updateCharts() {
    if (typeof Chart === 'undefined') return;
    const colors = getChartColors();
    const buckets = buildBuckets();
    const labels = buckets.map(b => b.label);

    let cumP = 0, cumI = 0;
    const cumPrincipal = [], cumInterest = [];
    buckets.forEach(b => {
      cumP += b.principal; cumI += b.interest;
      cumPrincipal.push(round2(cumP));
      cumInterest.push(round2(cumI));
    });

    Chart.defaults.color = colors.textMuted;
    Chart.defaults.borderColor = colors.grid;
    Chart.defaults.font.family = "Manrope, sans-serif";

    // LINE — cumulative principal vs interest
    const lineData = {
      labels: labels,
      datasets: [
        { label: 'Cumulative Principal', data: cumPrincipal, borderColor: colors.primary, backgroundColor: 'transparent', tension: .35, pointRadius: 0, borderWidth: 2.5 },
        { label: 'Cumulative Interest', data: cumInterest, borderColor: colors.blue, backgroundColor: 'transparent', tension: .35, pointRadius: 0, borderWidth: 2.5 }
      ]
    };
    if (charts.line) { charts.line.data = lineData; charts.line.update(); }
    else charts.line = new Chart($('lineChart').getContext('2d'), { type: 'line', data: lineData, options: baseLineOptions() });

    // DOUGHNUT — principal vs total interest
    const totalPayment = appState.schedule.reduce((s, r) => s + r.emi, 0);
    const totalInterest = totalPayment - appState.principal;
    const doughnutData = {
      labels: ['Principal', 'Interest'],
      datasets: [{ data: [round2(appState.principal), round2(totalInterest)], backgroundColor: [colors.primary, colors.blue], borderWidth: 0, hoverOffset: 6 }]
    };
    if (charts.doughnut) { charts.doughnut.data = doughnutData; charts.doughnut.update(); }
    else charts.doughnut = new Chart($('doughnutChart').getContext('2d'), { type: 'doughnut', data: doughnutData, options: { cutout: '72%', responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } } });
    $('doughnutValue').textContent = formatMoney(totalPayment);

    // AREA — outstanding balance
    const areaData = {
      labels: labels,
      datasets: [{ label: 'Outstanding Balance', data: buckets.map(b => round2(b.closing)), borderColor: colors.indigo, backgroundColor: hexToRgba(colors.indigo, .18), fill: true, tension: .35, pointRadius: 0, borderWidth: 2.5 }]
    };
    if (charts.area) { charts.area.data = areaData; charts.area.update(); }
    else charts.area = new Chart($('areaChart').getContext('2d'), { type: 'line', data: areaData, options: baseLineOptions() });

    // BAR — principal vs interest per period
    const barData = {
      labels: labels,
      datasets: [
        { label: 'Principal', data: buckets.map(b => round2(b.principal)), backgroundColor: colors.primary, borderRadius: 4 },
        { label: 'Interest', data: buckets.map(b => round2(b.interest)), backgroundColor: colors.blue, borderRadius: 4 }
      ]
    };
    if (charts.bar) { charts.bar.data = barData; charts.bar.update(); }
    else {
      charts.bar = new Chart($('barChart').getContext('2d'), {
        type: 'bar',
        data: barData,
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: { x: { grid: { display: false } }, y: { grid: { color: colors.grid }, ticks: { callback: v => compactMoney(v) } } },
          plugins: { legend: { position: 'bottom' } }
        }
      });
    }
  }

  function bindChartExportButtons() {
    const map = { lineChart: 'line', doughnutChart: 'doughnut', areaChart: 'area', barChart: 'bar' };
    $$('.export-chart-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const canvasId = btn.dataset.chart;
        const chart = charts[map[canvasId]];
        if (!chart) { showToast('Chart not ready yet', 'warning'); return; }
        const link = document.createElement('a');
        link.href = chart.toBase64Image();
        link.download = canvasId + '.png';
        document.body.appendChild(link);
        link.click();
        link.remove();
        showToast('Chart exported as PNG', 'success');
      });
    });
  }

  /* ============================================================
     GOAL SEEK — Newton-Raphson with bisection fallback
  ============================================================ */
  function bindGoalSeek() {
    const btn = $('goalSeekBtn');
    if (btn) btn.addEventListener('click', runGoalSeek);
  }

  function runGoalSeek() {
    const P = parseNumber($('gsPrincipal').value);
    const tenureVal = parseFloat($('gsTenure').value);
    const unit = $('gsTenureUnit').value;
    const months = unit === 'years' ? Math.round(tenureVal * 12) : Math.round(tenureVal);
    const desiredEmi = parseNumber($('gsEmi').value);

    $('gsError').textContent = '';

    if (!(P > 0) || !(months >= 1) || !(desiredEmi > 0)) {
      $('gsError').textContent = 'Please enter a valid principal, tenure and desired EMI.';
      $('gsResultGrid').innerHTML = '';
      return;
    }

    const minEmi = P / months; // EMI at 0% interest
    if (desiredEmi <= minEmi) {
      $('gsError').textContent = 'Desired EMI is too low. It must be greater than ' + formatMoney(minEmi) + ' (the 0% interest EMI) for this principal and tenure.';
      $('gsResultGrid').innerHTML = '';
      return;
    }

    // Newton-Raphson
    let rate = 10;
    let converged = false;
    const h = 1e-4;
    for (let i = 0; i < 100; i++) {
      const f = computeEMI(P, rate, months) - desiredEmi;
      if (Math.abs(f) < 0.01) { converged = true; break; }
      const fPrime = (computeEMI(P, rate + h, months) - computeEMI(P, rate - h, months)) / (2 * h);
      if (Math.abs(fPrime) < 1e-9) break;
      const next = rate - f / fPrime;
      if (!isFinite(next) || next < 0 || next > 100) break;
      rate = next;
    }

    // Bisection fallback / verification
    let finalRate = rate;
    let err = computeEMI(P, finalRate, months) - desiredEmi;
    if (!converged || Math.abs(err) > 1) {
      let lo = 0.0001, hi = 100;
      converged = false;
      for (let i = 0; i < 200; i++) {
        const mid = (lo + hi) / 2;
        const fm = computeEMI(P, mid, months) - desiredEmi;
        finalRate = mid;
        if (Math.abs(fm) < 0.001) { converged = true; break; }
        if (fm > 0) hi = mid; else lo = mid;
      }
    }

    if (finalRate >= 99.5 || !converged) {
      renderGoalSeekResult(null, 'fail', 'Could not find a realistic interest rate (it would exceed 100% APR). Try increasing the desired EMI or reducing the tenure.');
      return;
    }

    const finalEmi = computeEMI(P, finalRate, months);
    renderGoalSeekResult(finalRate, 'ok', null, finalEmi, P, months);
  }

  function renderGoalSeekResult(rate, status, errMsg, finalEmi, P, months) {
    if (status === 'fail') {
      $('gsResultGrid').innerHTML =
        '<div class="kpi-card status-fail"><i class="fa-solid fa-triangle-exclamation kpi-icon"></i>' +
        '<div class="kpi-label">Not Found</div><div class="kpi-value" style="font-size:.95rem;">' + errMsg + '</div></div>';
      showToast('Could not solve for a valid interest rate', 'error');
      return;
    }
    const totalPayment = finalEmi * months;
    const totalInterest = totalPayment - P;
    $('gsResultGrid').innerHTML =
      '<div class="kpi-card status-ok"><i class="fa-solid fa-percent kpi-icon"></i><div class="kpi-label">Annual Interest Rate</div><div class="kpi-value">' + rate.toFixed(3) + '%</div></div>' +
      '<div class="kpi-card"><i class="fa-solid fa-money-bill-wave kpi-icon"></i><div class="kpi-label">Resulting EMI</div><div class="kpi-value">' + formatMoney(finalEmi) + '</div></div>' +
      '<div class="kpi-card"><i class="fa-solid fa-sack-dollar kpi-icon"></i><div class="kpi-label">Total Interest</div><div class="kpi-value">' + formatMoney(totalInterest) + '</div></div>' +
      '<div class="kpi-card alt"><i class="fa-solid fa-coins kpi-icon"></i><div class="kpi-label">Total Payment</div><div class="kpi-value">' + formatMoney(totalPayment) + '</div></div>';
    showToast('Interest rate solved successfully', 'success');
  }

  /* ============================================================
     FORM BINDING — RANGE / TEXT SYNC / VALIDATION
  ============================================================ */
  function bindRangeText(rangeId, textId) {
    const range = $(rangeId), text = $(textId);
    range.addEventListener('input', () => { text.value = range.value; scheduleRecalc(); });
    text.addEventListener('input', () => {
      const raw = parseNumber(text.value);
      const clamped = clamp(raw, range.min, range.max);
      if (!isNaN(clamped)) range.value = clamped;
      scheduleRecalc();
    });
  }

  function adjustTenureRangeForUnit() {
    const unit = $('tenureUnit').value;
    const range = $('tenureRange');
    if (unit === 'years') {
      range.min = 1; range.max = 30;
      if (parseFloat($('tenure').value) > 30) $('tenure').value = 30;
    } else {
      range.min = 1; range.max = 360;
    }
    range.value = clamp($('tenure').value, range.min, range.max);
  }

  function bindEmiForm() {
    bindRangeText('principalRange', 'principal');
    bindRangeText('rateRange', 'rate');
    bindRangeText('tenureRange', 'tenure');

    $('tenureUnit').addEventListener('change', () => {
      adjustTenureRangeForUnit();
      scheduleRecalc();
    });

    $('calculateBtn').addEventListener('click', () => calculate(false));
    $('resetBtn').addEventListener('click', resetForm);

    $('principal').addEventListener('blur', () => {
      const v = parseNumber($('principal').value);
      $('principal').value = v.toLocaleString('en-IN');
    });
  }

  function resetForm() {
    $('principal').value = '2500000';
    $('principalRange').value = 2500000;
    $('rate').value = '8.5';
    $('rateRange').value = 8.5;
    $('tenure').value = '20';
    $('tenureUnit').value = 'years';
    adjustTenureRangeForUnit();
    clearError('principalError');
    clearError('rateError');
    clearError('tenureError');
    calculate(false);
    showToast('Form reset to default values', 'info');
  }

  /* ============================================================
     FABS, SCROLL, FULL REPORT
  ============================================================ */
  function bindFabs() {
    window.addEventListener('scroll', debounce(() => {
      const backBtn = $('backToTop');
      if (window.scrollY > 400) backBtn.classList.add('show'); else backBtn.classList.remove('show');
    }, 50));
    $('backToTop').addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
    $('fabPdf').addEventListener('click', generateFullReport);
    $('fullReportBtn').addEventListener('click', generateFullReport);
    $('copyAllBtn').addEventListener('click', () => copyTableData(repayController.getFiltered(), 'Loan Repayment Schedule'));
  }

  function generateFullReport() {
    if (typeof window.jspdf === 'undefined') { showToast('PDF library not loaded', 'error'); return; }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    const schedule = appState.schedule;
    const totalPayment = schedule.reduce((s, r) => s + r.emi, 0);
    const totalInterest = totalPayment - appState.principal;

    doc.setFontSize(18); doc.setTextColor(109, 40, 217);
    doc.text('OM SHAH — EMI & Loan Analysis Report', 14, 18);
    doc.setFontSize(10); doc.setTextColor(90, 90, 90);
    doc.text('Generated on ' + new Date().toLocaleString(), 14, 25);

    doc.setFontSize(11); doc.setTextColor(20, 20, 20);
    const summaryLines = [
      'Principal: ' + formatMoney(appState.principal),
      'Annual Interest Rate: ' + appState.rate + '%',
      'Tenure: ' + appState.tenureMonths + ' months',
      'Monthly EMI: ' + formatMoney(appState.emi),
      'Total Interest: ' + formatMoney(totalInterest),
      'Total Payment: ' + formatMoney(totalPayment)
    ];
    let y = 36;
    summaryLines.forEach(line => { doc.text(line, 14, y); y += 6; });

    try {
      if (charts.doughnut) {
        const img = charts.doughnut.toBase64Image();
        doc.addImage(img, 'PNG', 135, 28, 55, 55);
      }
    } catch (e) { /* ignore image embed failures */ }

    doc.autoTable({
      startY: y + 10,
      head: [EXPORT_HEADER],
      body: schedule.map(r => [r.no, formatMoney(r.opening), formatMoney(r.emi), formatMoney(r.interest), formatMoney(r.principal), formatMoney(r.closing)]),
      styles: { fontSize: 7 },
      headStyles: { fillColor: [109, 40, 217] },
      theme: 'striped'
    });

    doc.save('om-shah-emi-full-report.pdf');
    showToast('Full report generated', 'success');
  }

  /* ============================================================
     TOOLTIPS
  ============================================================ */
  function bindTooltips() {
    document.addEventListener('mouseover', e => {
      const el = e.target.closest('[title]');
      if (!el) return;
      if (!el.dataset.tooltipText) {
        el.dataset.tooltipText = el.getAttribute('title');
        el.removeAttribute('title');
      }
      showTooltip(el.dataset.tooltipText);
    });
    document.addEventListener('mousemove', e => {
      const tip = $('tooltipEl');
      if (tip.classList.contains('show')) {
        tip.style.left = (e.clientX + 14) + 'px';
        tip.style.top = (e.clientY + 14) + 'px';
      }
    });
    document.addEventListener('mouseout', e => {
      const el = e.target.closest('[data-tooltip-text]');
      if (el) hideTooltip();
    });
  }
  function showTooltip(text) { const tip = $('tooltipEl'); tip.textContent = text; tip.classList.add('show'); }
  function hideTooltip() { $('tooltipEl').classList.remove('show'); }

  /* ============================================================
     KEYBOARD SHORTCUTS
  ============================================================ */
  function onKeydown(e) {
    if (e.ctrlKey && e.key.toLowerCase() === 'd') { e.preventDefault(); toggleTheme(); }
    else if (e.ctrlKey && e.key.toLowerCase() === 'k') { e.preventDefault(); $('amortSearch').focus(); }
  }

  /* ============================================================
     INIT
  ============================================================ */
  function init() {
    restorePrefs();
    const yearEl = $('footerYear');
    if (yearEl) yearEl.textContent = new Date().getFullYear();

    bindEmiForm();
    adjustTenureRangeForUnit();

    $('themeToggle').addEventListener('click', toggleTheme);
    $('currencySelector').addEventListener('change', onCurrencyChange);

    bindGoalSeek();
    bindFabs();
    bindTooltips();
    bindChartExportButtons();
    document.addEventListener('keydown', onKeydown);

    amortController = createTableController({
      tableId: 'amortTable', bodyId: 'amortBody', footId: 'amortFoot', searchId: 'amortSearch',
      pageSizeId: 'amortPageSize', paginationId: 'amortPagination',
      copyBtnId: 'amortCopy', printBtnId: 'amortPrint', csvBtnId: 'amortCsv', excelBtnId: 'amortExcel', pdfBtnId: 'amortPdf',
      title: 'Amortization Schedule'
    });

    repayController = createTableController({
      tableId: 'repayTable', bodyId: 'repayBody', footId: null, searchId: 'repaySearch',
      pageSizeId: 'repayPageSize', paginationId: 'repayPagination',
      copyBtnId: 'repayCopy', printBtnId: 'repayPrint', csvBtnId: 'repayCsv', excelBtnId: 'repayExcel', pdfBtnId: 'repayPdf',
      title: 'Loan Repayment Schedule'
    });

    ensureChartHeights();
    calculate(true);

    window.addEventListener('load', hideLoader);
    setTimeout(hideLoader, 1500);
  }

  document.addEventListener('DOMContentLoaded', init);

})();
