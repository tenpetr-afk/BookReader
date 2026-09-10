/**
 * charts.js - Lehká SVG vizualizace statistik rychlosti čtení a aktivity.
 * Nevyžaduje žádné těžké knihovny (Chart.js apod.), je plně responzivní
 * a přizpůsobuje se světlému i tmavému motivu aplikace.
 */

export class StatsCharts {
  /**
   * Vykreslí sloupcový graf čtení za posledních 7 dní
   * @param {HTMLElement} container 
   * @param {Array<{label: string, minutes: number, words: number}>} data 
   */
  static renderDailyActivityChart(container, data) {
    if (!container) return;
    container.innerHTML = "";

    const width = container.clientWidth || 500;
    const height = 180;
    const padding = { top: 20, right: 15, bottom: 30, left: 35 };

    const chartW = width - padding.left - padding.right;
    const chartH = height - padding.top - padding.bottom;

    const maxMinutes = Math.max(30, ...data.map(d => d.minutes));
    const barWidth = Math.min(36, Math.max(16, (chartW / data.length) * 0.55));
    const step = chartW / data.length;

    let svg = `<svg width="100%" height="${height}" viewBox="0 0 ${width} ${height}" class="stats-svg-chart">
      <defs>
        <linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#38bdf8" />
          <stop offset="100%" stop-color="#0284c7" />
        </linearGradient>
      </defs>`;

    // Vodorovné mřížkové čáry
    const gridSteps = 3;
    for (let i = 0; i <= gridSteps; i++) {
      const yVal = Math.round((maxMinutes / gridSteps) * i);
      const yPos = padding.top + chartH - (i / gridSteps) * chartH;
      svg += `
        <line x1="${padding.left}" y1="${yPos}" x2="${width - padding.right}" y2="${yPos}" stroke="currentColor" stroke-opacity="0.08" stroke-dasharray="3,3" />
        <text x="${padding.left - 8}" y="${yPos + 4}" font-size="11" fill="currentColor" opacity="0.5" text-anchor="end">${yVal}m</text>
      `;
    }

    // Sloupce
    data.forEach((d, i) => {
      const x = padding.left + i * step + (step - barWidth) / 2;
      const barH = Math.max(3, (d.minutes / maxMinutes) * chartH);
      const y = padding.top + chartH - barH;

      svg += `
        <g class="chart-bar-group" tabindex="0">
          <rect x="${x}" y="${y}" width="${barWidth}" height="${barH}" rx="4" fill="url(#barGrad)">
            <title>${d.label}: ${d.minutes} minut (${d.words} slov)</title>
          </rect>
          <text x="${x + barWidth / 2}" y="${height - 10}" font-size="11" fill="currentColor" opacity="0.75" text-anchor="middle">${d.label}</text>
          ${d.minutes > 0 ? `<text x="${x + barWidth / 2}" y="${y - 6}" font-size="10" font-weight="bold" fill="currentColor" opacity="0.85" text-anchor="middle">${d.minutes}</text>` : ""}
        </g>
      `;
    });

    svg += `</svg>`;
    container.innerHTML = svg;
  }

  /**
   * Vykreslí křivku vývoje rychlosti čtení (WPM)
   * @param {HTMLElement} container 
   * @param {Array<{index: number, wpm: number, date: string, bookTitle: string}>} history 
   * @param {number} avgWpm 
   */
  static renderWpmProgressChart(container, history, avgWpm = 220) {
    if (!container) return;
    container.innerHTML = "";

    if (!history || history.length === 0) {
      container.innerHTML = `
        <div class="chart-empty-state">
          <p>Zatím nemáte dostatek dat o rychlosti čtení.</p>
          <span>Přečtěte alespoň pár stran knihy a graf se automaticky naplní.</span>
        </div>
      `;
      return;
    }

    const width = container.clientWidth || 500;
    const height = 180;
    const padding = { top: 25, right: 20, bottom: 25, left: 45 };

    const chartW = width - padding.left - padding.right;
    const chartH = height - padding.top - padding.bottom;

    const wpms = history.map(h => h.wpm);
    const minWpm = Math.max(50, Math.floor(Math.min(...wpms, avgWpm) * 0.8 / 50) * 50);
    const maxWpm = Math.ceil(Math.max(...wpms, avgWpm) * 1.2 / 50) * 50;
    const range = maxWpm - minWpm || 100;

    const getX = (idx) => {
      if (history.length === 1) return padding.left + chartW / 2;
      return padding.left + (idx / (history.length - 1)) * chartW;
    };

    const getY = (wpm) => {
      return padding.top + chartH - ((wpm - minWpm) / range) * chartH;
    };

    let points = history.map((h, i) => `${getX(i)},${getY(h.wpm)}`).join(" ");

    let svg = `<svg width="100%" height="${height}" viewBox="0 0 ${width} ${height}" class="stats-svg-chart">
      <defs>
        <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#10b981" stop-opacity="0.35" />
          <stop offset="100%" stop-color="#10b981" stop-opacity="0.0" />
        </linearGradient>
      </defs>`;

    // Vodorovná čára pro průměrné WPM
    const avgY = getY(avgWpm);
    svg += `
      <line x1="${padding.left}" y1="${avgY}" x2="${width - padding.right}" y2="${avgY}" stroke="#f59e0b" stroke-dasharray="4,4" stroke-width="1.5" opacity="0.7"/>
      <text x="${width - padding.right}" y="${avgY - 6}" font-size="10" fill="#f59e0b" font-weight="600" text-anchor="end">Průměr: ${avgWpm} WPM</text>
    `;

    // Plocha pod křivkou
    if (history.length > 1) {
      const areaPoints = `${getX(0)},${padding.top + chartH} ${points} ${getX(history.length - 1)},${padding.top + chartH}`;
      svg += `<polygon points="${areaPoints}" fill="url(#areaGrad)"/>`;
    }

    // Čára grafu
    svg += `<polyline fill="none" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" points="${points}" />`;

    // Jednotlivé body
    history.forEach((h, i) => {
      const cx = getX(i);
      const cy = getY(h.wpm);
      svg += `
        <circle cx="${cx}" cy="${cy}" r="4" fill="#ffffff" stroke="#10b981" stroke-width="2">
          <title>${h.wpm} WPM (${h.date} - ${h.bookTitle})</title>
        </circle>
      `;
    });

    // Osa Y popisky
    svg += `
      <text x="${padding.left - 8}" y="${getY(maxWpm) + 4}" font-size="10" fill="currentColor" opacity="0.5" text-anchor="end">${maxWpm}</text>
      <text x="${padding.left - 8}" y="${getY(minWpm) + 4}" font-size="10" fill="currentColor" opacity="0.5" text-anchor="end">${minWpm}</text>
    `;

    svg += `</svg>`;
    container.innerHTML = svg;
  }
}
