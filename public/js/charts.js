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
   * @param {Array<{index: number, wpm: number, avg_wpm?: number, avgWpm?: number, wordsRead?: number, durationSeconds?: number, date: string, timestamp?: number, startTime?: string, bookTitle: string}>} history 
   * @param {number} avgWpm 
   */
  static renderWpmProgressChart(container, history, avgWpm = 0) {
    if (!container) return;
    container.innerHTML = "";

    // Jeden bod pro každou platnou čtecí relaci s jejím skutečným přepočteným avg_wpm
    const validHistory = (history || []).map((h, idx) => {
      const dur = Number(h.durationSeconds ?? h.duration ?? 0);
      const words = Number(h.wordsRead ?? h.words_read ?? 0);
      const trueAvg = dur >= 10 && words > 0
        ? Math.round((words / dur) * 60)
        : Math.round(Number(h.avg_wpm ?? h.avgWpm ?? h.wpm ?? 0));
      return {
        ...h,
        index: h.index ?? (idx + 1),
        wpm: trueAvg
      };
    }).filter(h => h.wpm > 0 && h.wpm <= 1000);

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

    const wpms = validHistory.map(h => Math.round(h.wpm));
    const effectiveAvgWpm = avgWpm > 0
      ? Math.round(avgWpm)
      : Math.round(wpms.reduce((acc, v) => acc + v, 0) / wpms.length);

    // Dynamické meze osy Y zahrnující všechny body i celkový průměr s čistým odsazením
    const dataMin = Math.min(...wpms, effectiveAvgWpm);
    const dataMax = Math.max(...wpms, effectiveAvgWpm);
    const minWpm = Math.max(0, Math.floor((dataMin * 0.85) / 20) * 20);
    const maxWpm = Math.max(minWpm + 40, Math.ceil((dataMax * 1.15) / 20) * 20);
    const range = Math.max(40, maxWpm - minWpm);

    const getX = (idx) => {
      if (validHistory.length === 1) return padding.left + chartW / 2;
      return padding.left + (idx / (validHistory.length - 1)) * chartW;
    };

    const getY = (wpm) => {
      const clamped = Math.min(maxWpm, Math.max(minWpm, wpm));
      return padding.top + chartH - ((clamped - minWpm) / range) * chartH;
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
    const avgY = getY(effectiveAvgWpm);
    svg += `
      <line x1="${padding.left}" y1="${avgY}" x2="${width - padding.right}" y2="${avgY}" stroke="#f59e0b" stroke-dasharray="4,4" stroke-width="1.5" opacity="0.7"/>
      <text x="${width - padding.right}" y="${avgY - 6}" font-size="10" fill="#f59e0b" font-weight="600" text-anchor="end">Průměr: ${effectiveAvgWpm} WPM</text>
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

    const durationSeconds = Math.max(0, Number(sessionData.duration ?? sessionData.durationSeconds ?? sessionData.activeSeconds ?? 0));
    const wordsRead = Math.max(0, Number(sessionData.words_read ?? sessionData.wordsRead ?? 0));
    const computedAvgWpm = durationSeconds >= 10 ? Math.round((wordsRead / durationSeconds) * 60) : 0;
    const avgWpm = Number(
      sessionData.avg_wpm ?? sessionData.avgWpm ?? (computedAvgWpm > 0 ? computedAvgWpm : (sessionData.wpm ?? 0))
    );
    let rawSamples = Array.isArray(sessionData.intra_session_samples || sessionData.intraSessionSamples || sessionData.timelineSamples) 
      ? [...(sessionData.intra_session_samples || sessionData.intraSessionSamples || sessionData.timelineSamples)] 
      : [];

    // 1. Extrakce a normalizace 1-minutových vzorků
    let parsedSamples = rawSamples.map((s, idx) => {
      let sec = Number(s.elapsedSeconds ?? s.t ?? s.elapsedActiveSeconds ?? s.elapsedTime);
      const minuteFromProp = Number(s.minute);
      if (isNaN(sec) || sec <= 0) {
        if (!isNaN(minuteFromProp) && minuteFromProp > 0) {
          sec = minuteFromProp * 60;
        } else {
          sec = (idx + 1) * 60;
        }
      }
      const wpm = Math.max(0, Math.round(Number(s.wpm ?? s.instantaneousWpm ?? 0)));
      const words = s.words !== undefined
        ? Math.max(0, Math.round(Number(s.words)))
        : wpm;
      const minute = (!isNaN(minuteFromProp) && minuteFromProp > 0)
        ? minuteFromProp
        : Math.max(1, Math.ceil(sec / 60));
      return {
        minute,
        sec: Math.max(1, Math.round(sec)),
        words,
        wpm,
        isPartial: !!s.isPartial
      };
    }).filter(s => s.wpm >= 0 && s.wpm <= 1000 && s.sec > 0);

    // 2. Striktní vzestupné řazení podle času
    parsedSamples.sort((a, b) => a.sec - b.sec);

    // 3. Monotónní deduplikace podle času
    let dedupedSamples = [];
    for (const sample of parsedSamples) {
      if (dedupedSamples.length === 0) {
        dedupedSamples.push({ ...sample });
      } else {
        const last = dedupedSamples[dedupedSamples.length - 1];
        if (sample.sec === last.sec) {
          last.wpm = sample.wpm;
          last.words = sample.words;
          last.minute = sample.minute;
          last.isPartial = sample.isPartial;
        } else {
          dedupedSamples.push({ ...sample });
        }
      }
    }

    // Oříznutí počátečních nulových vzorků (pokud relace začala neaktivitou před zahájením čtení)
    const firstActiveIdx = dedupedSamples.findIndex(s => s.wpm > 0 || s.words > 0);
    if (firstActiveIdx > 0) {
      dedupedSamples = dedupedSamples.slice(firstActiveIdx);
    }

    // Pokud relace nemá uložené vzorky, ale má trvání a slova, vytvoříme 1-minutové body
    if (dedupedSamples.length === 0) {
      if (durationSeconds >= 15 && (wordsRead > 0 || avgWpm > 0)) {
        const fullMins = Math.floor(durationSeconds / 60);
        if (fullMins >= 1) {
          for (let m = 1; m <= fullMins; m++) {
            dedupedSamples.push({
              minute: m,
              sec: m * 60,
              words: avgWpm,
              wpm: avgWpm,
              isPartial: false
            });
          }
          const remSec = durationSeconds - fullMins * 60;
          if (remSec >= 15) {
            dedupedSamples.push({
              minute: fullMins + 1,
              sec: durationSeconds,
              words: Math.round((avgWpm * remSec) / 60),
              wpm: avgWpm,
              isPartial: true
            });
          }
        } else {
          dedupedSamples.push({
            minute: 1,
            sec: durationSeconds,
            words: wordsRead,
            wpm: avgWpm,
            isPartial: true
          });
        }
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

    // 4. Konstrukce bodů křivky: ukotvení na t = 0 bez umělé nulové police a pokrývající celou relaci
    const curvePoints = [];
    if (dedupedSamples[0].sec > 0) {
      const firstSampleWpm = dedupedSamples[0].wpm;
      const anchorStartWpm = firstSampleWpm > 0 ? firstSampleWpm : (avgWpm > 0 ? avgWpm : 0);
      curvePoints.push({ sec: 0, wpm: anchorStartWpm, isAnchor: true });
    }
    curvePoints.push(...dedupedSamples);
    const lastSample = dedupedSamples[dedupedSamples.length - 1];
    if (durationSeconds > lastSample.sec) {
      const lastSampleWpm = lastSample.wpm;
      const anchorEndWpm = lastSampleWpm > 0 ? lastSampleWpm : (avgWpm > 0 ? avgWpm : 0);
      curvePoints.push({ sec: durationSeconds, wpm: anchorEndWpm, isAnchor: true });
    }

    const maxElapsed = Math.max(durationSeconds, curvePoints[curvePoints.length - 1].sec, 60);

    // 5. Výpočet špičkové rychlosti (Peak WPM) - nikdy nesmí být nižší než avgWpm
    const sampleSpeeds = dedupedSamples.map(s => s.wpm).filter(w => w > 0);
    const rawPeak = sessionData.peak_wpm ?? sessionData.peakWpm;
    const peakWpm = rawPeak 
      ? Math.max(Math.round(rawPeak), avgWpm) 
      : (sampleSpeeds.length > 0 ? Math.max(...sampleSpeeds, avgWpm) : avgWpm);

    // Synchronizujeme odznaky špičkového a průměrného tempa v UI
    const peakBadge = document.getElementById("session-badge-peak-wpm");
    if (peakBadge) {
      peakBadge.textContent = `${peakWpm} WPM`;
    }
    const avgBadge = document.getElementById("session-badge-avg-wpm");
    if (avgBadge) {
      avgBadge.textContent = `${avgWpm} WPM`;
    }

    // 6. Dynamické meze pro osu Y zahrnující session.avg_wpm, session.peak_wpm a všechny vzorky s čistým odsazením
    const allYValues = [...sampleSpeeds];
    if (avgWpm > 0) allYValues.push(avgWpm);
    if (peakWpm > 0) allYValues.push(peakWpm);
    curvePoints.forEach(p => {
      if (p.wpm > 0) allYValues.push(p.wpm);
    });
    const dataMin = allYValues.length > 0 ? Math.min(...allYValues) : 0;
    const dataMax = allYValues.length > 0 ? Math.max(...allYValues) : 200;
    const minY = Math.max(0, Math.floor((dataMin * 0.8) / 20) * 20);
    const maxY = Math.max(minY + 40, Math.ceil((dataMax * 1.15) / 20) * 20);
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
    const points = curvePoints.map(s => ({
      x: getX(s.sec),
      y: getY(s.wpm),
      sec: s.sec,
      wpm: s.wpm,
      minute: s.minute,
      words: s.words,
      isPartial: !!s.isPartial,
      isAnchor: !!s.isAnchor
    }));

    // Sestavení plynulé Bézierovy křivky (Cubic Bezier Spline) garantovaně bez smyček v X a bez propadů pod 0
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
        // Tangenty v bodech p1 a p2
        let m1 = (p2.y - p0.y) / (p2.x - p0.x || 1);
        let m2 = (p3.y - p1.y) / (p3.x - p1.x || 1);

        // Ochrana proti přestřelení lokálních extrémů (Fritsch-Carlson monotonicita):
        // Pokud p1 nebo p2 je lokální extrém (změna směru), tangenta musí být nulová
        const d1 = (p2.y - p1.y) / (dx || 1);
        const d0 = (p1.y - p0.y) / (p1.x - p0.x || 1);
        const d2 = (p3.y - p2.y) / (p3.x - p2.x || 1);

        if (d0 * d1 <= 0) m1 = 0;
        if (d1 * d2 <= 0) m2 = 0;

        // Striktně monotónní v X: cp1x a cp2x jsou vždy vnitřní body úseku [p1.x, p2.x]
        const cp1x = p1.x + dx / 3;
        const cp2x = p2.x - dx / 3;

        // Kontrolní body Y
        let cp1y = p1.y + m1 * (dx / 3);
        let cp2y = p2.y - m2 * (dx / 3);

        // Clamping kontrolních bodů: nesmí přestřelit data ani hranice grafu [padding.top, padding.top + chartH]
        const segmentMinY = Math.min(p1.y, p2.y);
        const segmentMaxY = Math.max(p1.y, p2.y);
        const allowedTop = Math.max(padding.top, segmentMinY - Math.abs(p2.y - p1.y) * 0.25);
        const allowedBottom = Math.min(padding.top + chartH, segmentMaxY + Math.abs(p2.y - p1.y) * 0.25);

        cp1y = Math.max(allowedTop, Math.min(allowedBottom, cp1y));
        cp2y = Math.max(allowedTop, Math.min(allowedBottom, cp2y));

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

    // 2. Vertikální mřížka a popisky osy X po 1-minutových intervalech (1 min, 2 min, 3 min, ...)
    const totalMinutesFloor = Math.max(1, Math.floor(maxElapsed / 60));
    const maxTickLabels = Math.min(8, Math.max(3, Math.floor(chartW / 65)));
    const minuteStep = Math.max(1, Math.ceil(totalMinutesFloor / maxTickLabels));
    const xTicks = [];
    for (let m = minuteStep; m <= totalMinutesFloor; m += minuteStep) {
      xTicks.push({ sec: m * 60, label: `${m} min` });
    }
    if (xTicks.length === 0 || (maxElapsed - xTicks[xTicks.length - 1].sec) >= 30) {
      const endMin = Math.floor(maxElapsed / 60);
      const endSec = Math.round(maxElapsed % 60);
      const endLabel = endMin > 0
        ? (endSec === 0 ? `${endMin} min` : `${endMin}:${String(endSec).padStart(2, "0")}`)
        : `${endSec} s`;
      xTicks.push({ sec: maxElapsed, label: endLabel });
    }

    for (const tick of xTicks) {
      const xPos = getX(tick.sec);
      svg += `
        <line x1="${xPos}" y1="${padding.top}" x2="${xPos}" y2="${padding.top + chartH}" stroke="currentColor" stroke-opacity="0.05" stroke-dasharray="2,2" />
        <text x="${xPos}" y="${height - 12}" font-size="10" fill="currentColor" opacity="0.65" font-variant-numeric="tabular-nums" text-anchor="middle">${tick.label}</text>
      `;
    }

    // 3. Oranžová přerušovaná čára průměrné rychlosti (Průměr: X WPM) na přesné hodnotě session.avg_wpm
    const avgY = getY(avgWpm);
    svg += `
      <line x1="${padding.left}" y1="${avgY}" x2="${width - padding.right}" y2="${avgY}" stroke="#f59e0b" stroke-dasharray="4,4" stroke-width="1.5" opacity="0.85" />
      <text x="${width - padding.right}" y="${Math.max(padding.top + 10, avgY - 6)}" font-size="10" fill="#f59e0b" font-weight="700" text-anchor="end">Průměr: ${avgWpm} WPM</text>
    `;

    // 4. Vyplněná plocha pod křivkou
    svg += `<path d="${areaPath}" fill="url(#sessionTimelineGrad)" />`;

    // 5. Hlavní čára grafu
    svg += `<path d="${curvePath}" fill="none" stroke="#3b82f6" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round" />`;

    // 6. Nalezení bodu se špičkovou rychlostí (Peak WPM) mezi reálnými vzorky
    let peakPoint = null;
    for (const pt of points) {
      if (!pt.isAnchor) {
        if (!peakPoint || pt.wpm > peakPoint.wpm) {
          peakPoint = pt;
        }
      }
    }

    // 7. Vykreslení interaktivních 1-minutových bodů s počtem přečtených slov v dané minutě a WPM
    points.forEach((pt, idx) => {
      if (pt.isAnchor) return; // Ukotvovací pomocné body nevykreslují kruhový bod

      const isPeak = peakPoint && pt === peakPoint && (peakPoint.wpm > avgWpm || points.filter(p => !p.isAnchor).length === 1);
      const minNum = pt.minute || Math.max(1, Math.ceil(pt.sec / 60)) || idx;
      const wordsInMin = pt.words !== undefined ? pt.words : pt.wpm;
      const tooltipLabel = `${minNum}. minuta: ${wordsInMin} slov (${pt.wpm} WPM)`;

      if (isPeak) {
        svg += `
          <g class="chart-peak-marker" tabindex="0">
            <circle cx="${pt.x}" cy="${pt.y}" r="7" fill="rgba(236, 72, 153, 0.25)" filter="url(#glowEffect)" />
            <circle cx="${pt.x}" cy="${pt.y}" r="4.5" fill="#ffffff" stroke="#ec4899" stroke-width="2.5">
              <title>Špička – ${tooltipLabel}</title>
            </circle>
            <text x="${pt.x}" y="${Math.max(padding.top + 8, pt.y - 10)}" font-size="10" font-weight="800" fill="#ec4899" text-anchor="middle">${pt.wpm} WPM</text>
          </g>
        `;
      } else {
        svg += `
          <circle cx="${pt.x}" cy="${pt.y}" r="3.5" fill="#ffffff" stroke="#3b82f6" stroke-width="2" class="chart-point">
            <title>${tooltipLabel}</title>
          </circle>
        `;
      }
    });

    svg += `</svg>`;
    container.innerHTML = svg;
  }
}
