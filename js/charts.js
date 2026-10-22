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

    // Převod sekund na minuty až při vykreslování grafu
    const normalizedData = (data || []).map(d => {
      const minutes = typeof d.minutes === "number" ? d.minutes : Math.round((d.seconds || 0) / 60);
      return {
        ...d,
        minutes
      };
    });

    const maxMinutes = Math.max(30, ...normalizedData.map(d => d.minutes));
    const barWidth = Math.min(36, Math.max(16, (chartW / (normalizedData.length || 1)) * 0.55));
    const step = chartW / (normalizedData.length || 1);

    let svg = `<svg width="100%" height="${height}" viewBox="0 0 ${width} ${height}" class="stats-svg-chart" role="img" aria-label="Aktivita čtení za posledních 7 dní">
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
    normalizedData.forEach((d, i) => {
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
   * Vykreslí křivku vývoje rychlosti čtení (WPM) v historii relací
   * @param {HTMLElement} container 
   * @param {Array<{index: number, wpm: number, date: string, timestamp?: number, startTime?: string, bookTitle: string}>} history 
   * @param {number} avgWpm 
   */
  static renderWpmProgressChart(container, history, avgWpm = 220) {
    if (!container) return;
    container.innerHTML = "";

    // Filtrujeme pouze platné vzorky v pásmu [80, 650] WPM (žádné umělé clampingy)
    const validHistory = (history || []).filter(h => {
      const w = Math.round(h.wpm);
      return w >= 80 && w <= 650;
    });

    if (validHistory.length === 0) {
      container.innerHTML = `
        <div class="chart-empty-state">
          <p>Zatím nemáte dostatek dat o rychlosti čtení.</p>
          <span>Přečtěte alespoň pár stran knihy a graf se automaticky naplní.</span>
        </div>
      `;
      return;
    }

    const width = container.clientWidth || 500;
    const height = 210;
    const padding = { top: 25, right: 25, bottom: 38, left: 45 };

    const chartW = width - padding.left - padding.right;
    const chartH = height - padding.top - padding.bottom;

    const clampedAvgWpm = Math.max(80, Math.min(650, Math.round(avgWpm)));
    const wpms = validHistory.map(h => Math.round(h.wpm));
    // Dynamické meze osy Y odpovídající reálným datům uživatele (bez umělých stropů)
    const dataMin = Math.min(...wpms, clampedAvgWpm);
    const dataMax = Math.max(...wpms, clampedAvgWpm);
    const minWpm = Math.max(60, Math.floor((dataMin * 0.85) / 25) * 25);
    const maxWpm = Math.min(650, Math.ceil((dataMax * 1.15) / 25) * 25);
    const range = Math.max(50, maxWpm - minWpm);

    const getX = (idx) => {
      if (validHistory.length === 1) return padding.left + chartW / 2;
      return padding.left + (idx / (validHistory.length - 1)) * chartW;
    };

    const getY = (wpm) => {
      return padding.top + chartH - ((wpm - minWpm) / range) * chartH;
    };

    let points = validHistory.map((h, i) => `${getX(i).toFixed(1)},${getY(Math.round(h.wpm)).toFixed(1)}`).join(" ");

    let svg = `<svg width="100%" height="${height}" viewBox="0 0 ${width} ${height}" class="stats-svg-chart" role="img" aria-label="Globální historie rychlosti čtení">
      <defs>
        <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#10b981" stop-opacity="0.35" />
          <stop offset="100%" stop-color="#10b981" stop-opacity="0.0" />
        </linearGradient>
      </defs>`;

    // Vodorovná čára pro průměrné WPM
    const avgY = getY(clampedAvgWpm);
    svg += `
      <line x1="${padding.left}" y1="${avgY}" x2="${width - padding.right}" y2="${avgY}" stroke="#f59e0b" stroke-dasharray="4,4" stroke-width="1.5" opacity="0.7"/>
      <text x="${width - padding.right}" y="${avgY - 6}" font-size="10" fill="#f59e0b" font-weight="600" text-anchor="end">Průměr: ${clampedAvgWpm} WPM</text>
    `;

    // Plocha pod křivkou
    if (validHistory.length > 1) {
      const areaPoints = `${getX(0).toFixed(1)},${padding.top + chartH} ${points} ${getX(validHistory.length - 1).toFixed(1)},${padding.top + chartH}`;
      svg += `<polygon points="${areaPoints}" fill="url(#areaGrad)"/>`;
    }

    // Čára grafu
    svg += `<polyline fill="none" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" points="${points}" />`;

    // Jednotlivé body
    validHistory.forEach((h, i) => {
      const pointWpm = Math.round(h.wpm);
      const cx = getX(i);
      const cy = getY(pointWpm);
      svg += `
        <circle cx="${cx}" cy="${cy}" r="4" fill="#ffffff" stroke="#10b981" stroke-width="2">
          <title>${pointWpm} WPM (${h.date} - ${h.bookTitle})</title>
        </circle>
      `;
    });

    // Osa Y popisky
    svg += `
      <text x="${padding.left - 8}" y="${getY(maxWpm) + 4}" font-size="10" fill="currentColor" opacity="0.5" font-variant-numeric="tabular-nums" text-anchor="end">${maxWpm}</text>
      <text x="${padding.left - 8}" y="${getY(minWpm) + 4}" font-size="10" fill="currentColor" opacity="0.5" font-variant-numeric="tabular-nums" text-anchor="end">${minWpm}</text>
    `;

    // Osa X popisky (datum a čas čtecích relací bez překrývání)
    const hasMultipleDays = (() => {
      const dates = new Set(validHistory.map(h => h.date).filter(Boolean));
      return dates.size > 1;
    })();

    const formatSessionLabel = (h) => {
      let dateObj = null;
      if (h.timestamp) {
        dateObj = new Date(h.timestamp);
      } else if (h.startTime) {
        dateObj = new Date(h.startTime);
      } else if (h.date) {
        const parts = String(h.date).split("-");
        if (parts.length === 3) {
          dateObj = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
        }
      }

      if (dateObj && !isNaN(dateObj.getTime())) {
        const day = dateObj.getDate();
        const month = dateObj.getMonth() + 1;
        const dateStr = `${day}. ${month}.`;

        // Pokud jsou všechny relace ze stejného dne a máme čas, zobrazíme čas (HH:mm)
        if (!hasMultipleDays && (h.timestamp || h.startTime)) {
          const hours = String(dateObj.getHours()).padStart(2, "0");
          const mins = String(dateObj.getMinutes()).padStart(2, "0");
          return `${hours}:${mins}`;
        }
        return dateStr;
      }

      return String(h.date || `#${h.index || ""}`);
    };

    // Vzorkování popisků pro osu X podle šířky kontejneru
    const maxLabels = Math.min(6, Math.max(2, Math.floor(chartW / 75)));
    const labelIndices = new Set();
    if (validHistory.length <= maxLabels) {
      validHistory.forEach((_, i) => labelIndices.add(i));
    } else {
      for (let i = 0; i < maxLabels; i++) {
        const idx = Math.round((i / (maxLabels - 1)) * (validHistory.length - 1));
        labelIndices.add(idx);
      }
    }

    labelIndices.forEach(idx => {
      const cx = getX(idx);
      const label = formatSessionLabel(validHistory[idx]);
      let textAnchor = "middle";
      if (idx === 0 && validHistory.length > 1) {
        textAnchor = "start";
      } else if (idx === validHistory.length - 1 && validHistory.length > 1) {
        textAnchor = "end";
      }

      svg += `
        <line x1="${cx}" y1="${padding.top}" x2="${cx}" y2="${padding.top + chartH}" stroke="currentColor" stroke-opacity="0.04" stroke-dasharray="2,2" />
        <line x1="${cx}" y1="${padding.top + chartH}" x2="${cx}" y2="${padding.top + chartH + 4}" stroke="currentColor" stroke-opacity="0.25" />
        <text x="${cx}" y="${height - 12}" font-size="10" fill="currentColor" opacity="0.65" font-variant-numeric="tabular-nums" text-anchor="${textAnchor}">${label}</text>
      `;
    });

    svg += `</svg>`;
    container.innerHTML = svg;
  }

  /**
   * Vykreslí detailní graf průběhu rychlosti čtení v rámci jedné čtecí relace (Intra-session WPM timeline)
   * Zobrazuje akceleraci a deceleraci čtenáře s časem na ose X a rychlostí WPM na ose Y.
   * @param {HTMLElement} container Cílový element
   * @param {Object} sessionData Data vybrané čtecí relace
   */
  static renderSessionTimelineChart(container, sessionData) {
    if (!container) return;
    container.innerHTML = "";

    if (!sessionData) {
      container.innerHTML = `
        <div class="chart-empty-state">
          <p>Není vybrána žádná čtecí relace.</p>
        </div>
      `;
      return;
    }

    const durationSeconds = Number(sessionData.durationSeconds ?? sessionData.activeSeconds ?? 0);
    const avgWpm = Number(sessionData.avgWpm ?? sessionData.wpm ?? 220);
    let rawSamples = Array.isArray(sessionData.timelineSamples) ? [...sessionData.timelineSamples] : [];

    // 1. Extrakce a normalizace vzorků (Monotonic Elapsed Active Time)
    let parsedSamples = rawSamples.map(s => {
      let sec = Number(s.elapsedActiveSeconds ?? s.elapsedSeconds ?? s.elapsedTime);
      if (isNaN(sec) || sec < 0) {
        if (s.timestamp && sessionData.startTime) {
          const startMs = new Date(sessionData.startTime).getTime();
          sec = Math.max(0, Math.round((s.timestamp - startMs) / 1000));
        } else {
          sec = 0;
        }
      }
      const wpm = Number(s.instantaneousWpm ?? s.wpm ?? 0);
      return {
        sec: Math.max(0, Math.round(sec)),
        wpm: Math.round(wpm)
      };
    }).filter(s => s.wpm >= 60 && s.wpm <= 650);

    // 2. Striktní vzestupné řazení podle uplynulého aktivního času (Consistent Sorting)
    parsedSamples.sort((a, b) => a.sec - b.sec);

    // 3. Monotónní deduplikace a eliminace duplicitních bodů
    const dedupedSamples = [];
    for (const sample of parsedSamples) {
      if (dedupedSamples.length === 0) {
        dedupedSamples.push({ ...sample });
      } else {
        const last = dedupedSamples[dedupedSamples.length - 1];
        if (sample.sec <= last.sec + 1) {
          // Bod je ve stejnou sekundu nebo do 1s: zprůměrujeme tempo
          last.wpm = Math.round((last.wpm + sample.wpm) / 2);
        } else {
          dedupedSamples.push({ ...sample });
        }
      }
    }

    // 4. Outlier Clamping: Cap unrealistic transient velocity spikes
    // Zabráníme tomu, aby mikro-intervaly (rychlé otočení stránky za < 3s, skimming)
    // vytvořily zkreslenou špičku (např. 494 WPM) deformující měřítko grafu a odznak špičky
    const maxAllowedPace = Math.min(650, Math.max(280, Math.round(avgWpm * 1.65)));

    // 5. Smoothed Rolling WPM Calculation (EMA smoothing přes vzorky)
    let currentEma = avgWpm;
    let smoothedSamples = dedupedSamples.map((s, idx) => {
      const clampedWpm = Math.max(70, Math.min(maxAllowedPace, s.wpm));
      if (idx === 0) {
        currentEma = clampedWpm;
      } else {
        const alpha = 0.35;
        currentEma = Math.round(currentEma * (1 - alpha) + clampedWpm * alpha);
      }
      return {
        sec: s.sec,
        wpm: currentEma
      };
    });

    // Pokud relace nemá uložené vzorky, ale má trvání a průměrné WPM, vytvoříme referenční linku
    if (smoothedSamples.length === 0) {
      if (durationSeconds >= 5) {
        smoothedSamples = [
          { sec: 0, wpm: avgWpm },
          { sec: durationSeconds, wpm: avgWpm }
        ];
      } else {
        container.innerHTML = `
          <div class="chart-empty-state">
            <p>Tato relace trvala příliš krátce pro vykreslení časové osy.</p>
            <span>Graf se generuje u relací delších než 15 sekund.</span>
          </div>
        `;
        return;
      }
    }

    // Pokud máme jen 1 vzorek na začátku relace, doplníme koncový bod
    if (smoothedSamples.length === 1) {
      const endSec = Math.max(durationSeconds, smoothedSamples[0].sec + 10);
      smoothedSamples.push({
        sec: endSec,
        wpm: avgWpm || smoothedSamples[0].wpm
      });
    }

    const samples = smoothedSamples;
    const maxElapsed = Math.max(durationSeconds, samples[samples.length - 1].sec, 10);

    // Výpočet dynamických mezí pro osu Y v pásmu [80, 650] WPM
    const clampedAvgWpm = Math.max(80, Math.min(650, Math.round(avgWpm)));
    const sampleSpeeds = samples.map(s => s.wpm);
    const peakWpm = Math.max(...sampleSpeeds, clampedAvgWpm);
    const lowestWpm = Math.min(...sampleSpeeds, clampedAvgWpm);

    // Synchronizujeme odznak špičkového tempa v UI s reálným vyhlazeným peakem
    const peakBadge = document.getElementById("session-badge-peak-wpm");
    if (peakBadge) {
      peakBadge.textContent = `${peakWpm} WPM`;
    }

    const minY = Math.max(50, Math.floor((lowestWpm * 0.85) / 25) * 25);
    const maxY = Math.min(650, Math.max(minY + 50, Math.ceil((peakWpm * 1.15) / 25) * 25));
    const rangeY = maxY - minY || 100;

    const width = container.clientWidth || 560;
    const height = 210;
    const padding = { top: 28, right: 30, bottom: 38, left: 48 };

    const chartW = width - padding.left - padding.right;
    const chartH = height - padding.top - padding.bottom;

    const getX = (sec) => {
      const clamped = Math.min(maxElapsed, Math.max(0, sec));
      return padding.left + (clamped / maxElapsed) * chartW;
    };

    const getY = (wpm) => {
      const clamped = Math.min(maxY, Math.max(minY, wpm));
      return padding.top + chartH - ((clamped - minY) / rangeY) * chartH;
    };

    // Body křivky
    const points = samples.map(s => ({
      x: getX(s.sec),
      y: getY(s.wpm),
      sec: s.sec,
      wpm: s.wpm
    }));

    // Sestavení plynulé Bézierovy křivky (Cubic Bezier Spline) garantovaně bez smyček v X
    let curvePath = `M ${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`;
    if (points.length === 2) {
      curvePath += ` L ${points[1].x.toFixed(1)},${points[1].y.toFixed(1)}`;
    } else {
      for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[i === 0 ? 0 : i - 1];
        const p1 = points[i];
        const p2 = points[i + 1];
        const p3 = points[i + 2] || p2;

        const dx = p2.x - p1.x;
        const m1 = (p2.y - p0.y) / (p2.x - p0.x || 1);
        const m2 = (p3.y - p1.y) / (p3.x - p1.x || 1);

        // Striktně monotónní v X: cp1x a cp2x jsou vždy vnitřní body úseku [p1.x, p2.x]
        const cp1x = p1.x + dx / 3;
        const cp2x = p2.x - dx / 3;

        // Kontrolní body Y s omezením sklonu proti přestřelení
        let cp1y = p1.y + m1 * (dx / 3);
        let cp2y = p2.y - m2 * (dx / 3);

        const minYVal = Math.min(p1.y, p2.y) - Math.abs(p2.y - p1.y) * 0.3;
        const maxYVal = Math.max(p1.y, p2.y) + Math.abs(p2.y - p1.y) * 0.3;
        cp1y = Math.max(padding.top, Math.min(padding.top + chartH, Math.max(minYVal, Math.min(maxYVal, cp1y))));
        cp2y = Math.max(padding.top, Math.min(padding.top + chartH, Math.max(minYVal, Math.min(maxYVal, cp2y))));

        curvePath += ` C ${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
      }
    }

    // Uzavřená plocha pod křivkou pro gradient
    const areaPath = `${curvePath} L ${points[points.length - 1].x.toFixed(1)},${padding.top + chartH} L ${points[0].x.toFixed(1)},${padding.top + chartH} Z`;

    let svg = `<svg width="100%" height="${height}" viewBox="0 0 ${width} ${height}" class="stats-svg-chart timeline-svg-chart" role="img" aria-label="Graf rychlosti v čase relace">
      <defs>
        <linearGradient id="sessionTimelineGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.38" />
          <stop offset="60%" stop-color="#3b82f6" stop-opacity="0.10" />
          <stop offset="100%" stop-color="#3b82f6" stop-opacity="0.0" />
        </linearGradient>
        <filter id="glowEffect" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="2.5" result="blur" />
          <feComposite in="SourceGraphic" in2="blur" operator="over" />
        </filter>
      </defs>`;

    // 1. Horizontální mřížka (WPM)
    const yGridSteps = 4;
    for (let i = 0; i <= yGridSteps; i++) {
      const val = Math.round(minY + (rangeY / yGridSteps) * i);
      const yPos = padding.top + chartH - (i / yGridSteps) * chartH;
      svg += `
        <line x1="${padding.left}" y1="${yPos}" x2="${width - padding.right}" y2="${yPos}" stroke="currentColor" stroke-opacity="0.08" stroke-dasharray="3,3" />
        <text x="${padding.left - 8}" y="${yPos + 4}" font-size="10.5" fill="currentColor" opacity="0.55" font-variant-numeric="tabular-nums" text-anchor="end">${val}</text>
      `;
    }

    // 2. Vertikální mřížka (Čas relace)
    const xGridSteps = Math.min(5, Math.max(2, Math.floor(chartW / 90)));
    for (let i = 0; i <= xGridSteps; i++) {
      const secVal = Math.round((maxElapsed / xGridSteps) * i);
      const xPos = padding.left + (i / xGridSteps) * chartW;
      
      let timeLabel = "";
      if (secVal < 60) {
        timeLabel = `${secVal} s`;
      } else {
        const m = Math.floor(secVal / 60);
        const s = secVal % 60;
        timeLabel = s === 0 ? `${m} min` : `${m}:${String(s).padStart(2, "0")}`;
      }

      svg += `
        <line x1="${xPos}" y1="${padding.top}" x2="${xPos}" y2="${padding.top + chartH}" stroke="currentColor" stroke-opacity="0.05" stroke-dasharray="2,2" />
        <text x="${xPos}" y="${height - 12}" font-size="10" fill="currentColor" opacity="0.65" font-variant-numeric="tabular-nums" text-anchor="middle">${timeLabel}</text>
      `;
    }

    // 3. Referenční linka průměrné rychlosti (Average WPM)
    const avgY = getY(avgWpm);
    svg += `
      <line x1="${padding.left}" y1="${avgY}" x2="${width - padding.right}" y2="${avgY}" stroke="#f59e0b" stroke-dasharray="4,4" stroke-width="1.5" opacity="0.75" />
      <text x="${width - padding.right}" y="${avgY - 6}" font-size="10" fill="#f59e0b" font-weight="700" text-anchor="end">Průměr: ${avgWpm} WPM</text>
    `;

    // 4. Vyplněná plocha pod křivkou
    svg += `<path d="${areaPath}" fill="url(#sessionTimelineGrad)" />`;

    // 5. Hlavní čára grafu
    svg += `<path d="${curvePath}" fill="none" stroke="#3b82f6" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round" />`;

    // 6. Nalezení bodu se špičkovou rychlostí (Peak WPM)
    let peakPoint = points[0];
    for (const pt of points) {
      if (pt.wpm > peakPoint.wpm) {
        peakPoint = pt;
      }
    }

    // 7. Vykreslení interaktivních bodů (pokud není bodů extrémně mnoho)
    const shouldDrawAllPoints = points.length <= 40;
    const step = shouldDrawAllPoints ? 1 : Math.ceil(points.length / 30);

    points.forEach((pt, idx) => {
      const isPeak = pt === peakPoint && pt.wpm > (avgWpm + 10);
      const isEndpoint = idx === 0 || idx === points.length - 1;
      
      if (!isPeak && !isEndpoint && idx % step !== 0) return;

      const m = Math.floor(pt.sec / 60);
      const s = pt.sec % 60;
      const timeStr = m > 0 ? `${m} min ${s} s` : `${s} s`;

      if (isPeak) {
        svg += `
          <g class="chart-peak-marker" tabindex="0">
            <circle cx="${pt.x}" cy="${pt.y}" r="7" fill="rgba(236, 72, 153, 0.25)" filter="url(#glowEffect)" />
            <circle cx="${pt.x}" cy="${pt.y}" r="4.5" fill="#ffffff" stroke="#ec4899" stroke-width="2.5">
              <title>Špička: ${pt.wpm} WPM (v čase ${timeStr})</title>
            </circle>
            <text x="${pt.x}" y="${Math.max(padding.top + 8, pt.y - 10)}" font-size="10" font-weight="800" fill="#ec4899" text-anchor="middle">${pt.wpm} WPM</text>
          </g>
        `;
      } else {
        svg += `
          <circle cx="${pt.x}" cy="${pt.y}" r="3.5" fill="#ffffff" stroke="#3b82f6" stroke-width="2" class="chart-point">
            <title>${pt.wpm} WPM (v čase ${timeStr})</title>
          </circle>
        `;
      }
    });

    svg += `</svg>`;
    container.innerHTML = svg;
  }
}
