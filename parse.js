/* Booking Pass — reads a pasted confirmation email and pulls out whatever booking
   details it can find. Runs entirely on the device; nothing is sent anywhere.
   It is a best guess: the booking form shows the result so it can be checked. */
(function (root) {
  'use strict';

  const pad = (n) => String(n).padStart(2, '0');

  // ---------- text cleanup ----------

  function normalize(text) {
    return String(text || '')
      .replace(/\r\n?/g, '\n')
      .replace(/[​-‍⁠﻿]/g, '')
      .replace(/[   \t]/g, ' ')
      .replace(/ {2,}/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // Forwarded emails carry "From: / Date: / To:" header lines; their dates are noise.
  function dropEmailHeaders(t) {
    const lines = t.split('\n');
    const isFrom = (s) => /^from\s*:/i.test(s);
    const isHeader = (s) => /^(from|to|cc|bcc|date|sent|reply-to)\s*:/i.test(s);
    const keep = lines.filter((line, i) => {
      if (!isHeader(line)) return true;
      for (let j = Math.max(0, i - 4); j <= Math.min(lines.length - 1, i + 4); j++) {
        if (isFrom(lines[j])) return false;
      }
      return true;
    });
    return keep.join('\n');
  }

  // Weight of the nearest context keyword in the `span` characters before `idx`.
  function contextWeight(t, idx, rules, span) {
    const win = t.slice(Math.max(0, idx - span), idx).toLowerCase();
    let best = null;
    for (const [re, weight] of rules) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(win))) {
        const end = m.index + m[0].length;
        if (!best || end > best.end) best = { end, weight };
      }
    }
    return best ? best.weight : 0;
  }

  // ---------- dates ----------

  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const MON = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?(?![a-z])';
  const DAY = '(\\d{1,2})(?:st|nd|rd|th)?(?!\\d|:\\d)';
  const YEAR = '(?:,?\\s+(20\\d{2}))?(?!\\d)';
  const RE_MON_DAY = new RegExp('\\b' + MON + '\\s+' + DAY + YEAR, 'gi');
  const RE_DAY_MON = new RegExp('\\b' + DAY + '\\s+' + MON + YEAR, 'gi');
  const RE_ISO = /\b(20\d{2})-(\d{2})-(\d{2})\b/g;
  const RE_SLASH = /\b(\d{1,2})\/(\d{1,2})\/(20\d{2}|\d{2})\b/g;

  const DATE_RULES = [
    [/check-?\s?in|pick-?\s?up|depart(?:s|ure|ing)?|board(?:s|ing)?|outbound/g, 3],
    [/arriv(?:al|e|es|ing)|\bdate\b|\bwhen\b|reservation|reserved|your table|\btour\b|activity/g, 2],
    [/check-?\s?out|drop-?\s?off|return(?:s|ing)?|inbound/g, -1],
    [/booked|issued|\bsent\b|\bmade\b|purchased|ordered|cancel|refund|modif|expir|receipt|printed|generated|copyright|©/g, -3],
  ];

  function realDate(y, m, d) {
    const dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
  }

  function findDates(t, now) {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const out = [];
    const add = (idx, len, y, m, d) => {
      const hasYear = !!y;
      if (!hasYear) {
        y = now.getFullYear();
        // No year given: assume the next time that date comes around.
        if (new Date(y, m - 1, d) < new Date(today.getFullYear(), today.getMonth(), today.getDate() - 7)) y += 1;
      } else if (y < 100) {
        y += 2000;
      }
      if (!realDate(y, m, d)) return;
      const past = new Date(y, m - 1, d) < today;
      out.push({ idx, end: idx + len, date: `${y}-${pad(m)}-${pad(d)}`, hasYear, past });
    };
    // Lowercase "may" is nearly always the verb ("you may cancel…").
    const monthNum = (word) => (word === 'may' ? 0 : MONTHS[word.slice(0, 3).toLowerCase()]);
    let m;
    RE_MON_DAY.lastIndex = 0;
    while ((m = RE_MON_DAY.exec(t))) {
      const mo = monthNum(m[1]);
      if (mo) add(m.index, m[0].length, m[3] ? +m[3] : 0, mo, +m[2]);
    }
    RE_DAY_MON.lastIndex = 0;
    while ((m = RE_DAY_MON.exec(t))) {
      const mo = monthNum(m[2]);
      if (mo) add(m.index, m[0].length, m[3] ? +m[3] : 0, mo, +m[1]);
    }
    RE_ISO.lastIndex = 0;
    while ((m = RE_ISO.exec(t))) add(m.index, m[0].length, +m[1], +m[2], +m[3]);
    RE_SLASH.lastIndex = 0;
    while ((m = RE_SLASH.exec(t))) {
      let a = +m[1], b = +m[2];
      if (a > 12 && b <= 12) [a, b] = [b, a]; // day/month order
      add(m.index, m[0].length, +m[3], a, b);
    }
    return out.sort((x, y) => x.idx - y.idx);
  }

  function pickDate(t, dates) {
    let best = null;
    for (const d of dates) {
      const score = contextWeight(t, d.idx, DATE_RULES, 50) + (d.hasYear ? 0.5 : 0) - (d.past ? 1 : 0);
      if (!best || score > best.score) best = { ...d, score };
    }
    return best;
  }

  // ---------- times ----------

  const RE_12H = /\b(\d{1,2})(?:[:.](\d{2}))?\s?([ap])\.?\s?m\b\.?/gi;
  const RE_24H = /\b([01]?\d|2[0-3])[:h]([0-5]\d)\b(?!\s?[ap]\.?\s?m\b)/gi;
  const TIME_RULES = [
    [/check-?\s?in|pick-?\s?up|depart(?:s|ure|ing)?|board(?:s|ing)?|reservation|\btime\b|\bat\b/g, 3],
    [/arriv(?:al|e|es|ing)/g, 1],
    [/check-?\s?out|drop-?\s?off|return(?:s|ing)?|cancel/g, -2],
  ];

  function findTimes(t) {
    const out = [];
    let m;
    RE_12H.lastIndex = 0;
    while ((m = RE_12H.exec(t))) {
      let h = +m[1];
      const min = m[2] ? +m[2] : 0;
      if (h < 1 || h > 12 || min > 59) continue;
      const pm = m[3].toLowerCase() === 'p';
      if (pm && h !== 12) h += 12;
      if (!pm && h === 12) h = 0;
      out.push({ idx: m.index, time: `${pad(h)}:${pad(min)}` });
    }
    RE_24H.lastIndex = 0;
    while ((m = RE_24H.exec(t))) {
      if (out.some((x) => Math.abs(x.idx - m.index) < 3)) continue;
      out.push({ idx: m.index, time: `${pad(+m[1])}:${m[2]}` });
    }
    return out.sort((a, b) => a.idx - b.idx);
  }

  function pickTime(t, times, date) {
    if (!times.length) return '';
    if (date) {
      const after = times.find((x) => x.idx >= date.end && x.idx - date.end <= 120);
      if (after) return after.time;
      const before = times.filter((x) => x.idx < date.idx && date.idx - x.idx <= 60).pop();
      if (before) return before.time;
    }
    let best = null;
    for (const x of times) {
      const score = contextWeight(t, x.idx, TIME_RULES, 40);
      if (!best || score > best.score) best = { ...x, score };
    }
    return best.time;
  }

  // ---------- confirmation number ----------

  const CONF_LABELS = [
    [/\b(?:airline\s+)?confirmation(?:\s+(?:number|no\.?|code|#))?|\bconf(?:\.|\s)\s*(?:#|no\.?|number|code)?/gi, 3],
    [/\brecord\s+locator|\bPNR\b|\bbooking\s+(?:reference|ref\.?|code)/gi, 3],
    [/\b(?:reservation|booking|itinerary|trip|order)\s+(?:number|no\.?|#|id|code)|\breference\s+(?:number|no\.?|code|#)|\bref\.?\s*(?:no\.?|#)/gi, 2],
  ];
  const CONF_FILLER = /(?:[\s:#.\-–—]|\b(?:is|number|no|code)\b)*/iy;
  const CONF_TOKEN = /[A-Za-z0-9][A-Za-z0-9-]{2,24}/y;
  const CONF_DIGIT_GROUPS = /(?: \d{2,8})+(?![A-Za-z0-9])/y;
  const CONF_STOP = new Set([
    'NUMBER', 'NUMBERS', 'CODE', 'DETAILS', 'EMAIL', 'STATUS', 'PLEASE', 'THANKS', 'TRAVEL',
    'FLIGHT', 'HOTELS', 'RENTAL', 'RETURN', 'PICKUP', 'BOOKED', 'BELOW', 'ABOVE', 'CONFIRMED',
    'RECEIPT', 'SUMMARY', 'TICKET', 'GUESTS', 'ITINERARY', 'BOOKING', 'RESERVATION',
  ]);

  function validConf(tok) {
    const bare = tok.replace(/-/g, '');
    if (bare.length < 4 || bare.length > 22) return false;
    if (CONF_STOP.has(tok.toUpperCase())) return false;
    if (/\d/.test(bare)) return !/^(19|20)\d{2}$/.test(bare); // a bare year is not a code
    return /^[A-Z]{6}$/.test(tok); // all-letter codes: airline record locators
  }

  function findConf(t) {
    const found = [];
    for (const [re, priority] of CONF_LABELS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(t))) {
        CONF_FILLER.lastIndex = m.index + m[0].length;
        CONF_FILLER.exec(t);
        CONF_TOKEN.lastIndex = CONF_FILLER.lastIndex;
        const tok = CONF_TOKEN.exec(t);
        if (!tok) continue;
        let value = tok[0].replace(/-+$/, '');
        if (/^\d+$/.test(value)) {
          CONF_DIGIT_GROUPS.lastIndex = CONF_TOKEN.lastIndex;
          const more = CONF_DIGIT_GROUPS.exec(t);
          if (more) value += more[0];
        }
        if (validConf(value)) found.push({ priority, idx: m.index, value });
      }
    }
    found.sort((a, b) => b.priority - a.priority || a.idx - b.idx);
    return found.length ? found[0].value : '';
  }

  // ---------- phone ----------

  const PHONE_RES = [
    /(?:(?:\+\d{1,3}|\b1)[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]\d{4}\b/g,
    /\+\d{1,3}(?:[\s.-]?\(?\d{1,5}\)?){2,6}/g,
  ];
  const PHONE_RULES = [
    [/phone|\btel\b|call|contact|text us|front desk|questions|reach/g, 2],
    [/\bfax\b/g, -3],
  ];

  function findPhone(t) {
    const cands = [];
    for (const re of PHONE_RES) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(t))) {
        const digits = m[0].replace(/\D/g, '');
        if (digits.length < 10 || digits.length > 15) continue;
        if (cands.some((c) => m.index >= c.idx && m.index < c.idx + c.value.length)) continue;
        cands.push({ idx: m.index, value: m[0].trim() });
      }
    }
    let best = null;
    for (const c of cands) {
      const score = contextWeight(t, c.idx, PHONE_RULES, 40);
      if (!best || score > best.score || (score === best.score && c.idx < best.idx)) best = { ...c, score };
    }
    return best ? best.value : '';
  }

  // ---------- address ----------

  const STREET = /\b\d{1,6}[A-Za-z]?\s+(?!(?:a\.?m|p\.?m)\b)(?:[A-Za-z]|\d+(?:st|nd|rd|th)\b)/i;
  const CITY_STATE_ZIP = /([A-Z][A-Za-z.'’\- ]{1,40}?),?\s+([A-Z]{2}|[A-Z][a-z]+(?: [A-Z][a-z]+)?)\.?\s+(\d{5}(?:-\d{4})?)\b/;
  const ADDRESS_LABEL = /^(?:address|location|pick-?\s?up location|meeting point|where|property address|hotel address)\s*[:\-]?\s*(.*)$/i;

  const tidyAddress = (s) => s.replace(/\s*,\s*/g, ', ').replace(/[,\s]+$/, '').trim();

  function findAddress(t) {
    const lines = t.split('\n').map((s) => s.trim()).filter(Boolean);
    const cszEnd = (line) => {
      const m = CITY_STATE_ZIP.exec(line);
      return m ? m.index + m[0].length : -1;
    };
    for (let i = 0; i < lines.length; i++) {
      const s = STREET.exec(lines[i]);
      if (!s) continue;
      const street = lines[i].slice(s.index);
      const end = cszEnd(street);
      if (end > 0) return { address: tidyAddress(street.slice(0, end)), city: CITY_STATE_ZIP.exec(street)[1].trim() };
      const next = lines[i + 1];
      if (next && !STREET.test(next) && cszEnd(next) > 0) {
        return { address: tidyAddress(street + ', ' + next.slice(0, cszEnd(next))), city: CITY_STATE_ZIP.exec(next)[1].trim() };
      }
      const after = lines[i + 2];
      if (next && after && next.length < 40 && !STREET.test(after) && cszEnd(after) > 0) {
        return { address: tidyAddress([street, next, after.slice(0, cszEnd(after))].join(', ')), city: CITY_STATE_ZIP.exec(after)[1].trim() };
      }
    }
    // Outside the US: fall back to a labeled "Address:" line.
    for (let i = 0; i < lines.length; i++) {
      const m = ADDRESS_LABEL.exec(lines[i]);
      if (!m) continue;
      let a = m[1].trim();
      const looksLikeMore = (s) => s && !/[:@]/.test(s) && s.length < 60 && !findPhone(s);
      if (!a && looksLikeMore(lines[i + 1])) {
        a = lines[i + 1];
        if (looksLikeMore(lines[i + 2]) && /\d/.test(lines[i + 2])) a += ', ' + lines[i + 2];
      } else if (a && a.length < 30 && looksLikeMore(lines[i + 1])) {
        a += ', ' + lines[i + 1];
      }
      if (a && /\d|,/.test(a)) return { address: tidyAddress(a), city: '' };
    }
    return { address: '', city: '' };
  }

  // ---------- names ----------

  const AIRLINES = {
    DL: 'Delta', UA: 'United', AA: 'American', WN: 'Southwest', AS: 'Alaska', B6: 'JetBlue',
    NK: 'Spirit', F9: 'Frontier', G4: 'Allegiant', HA: 'Hawaiian', SY: 'Sun Country',
    AC: 'Air Canada', WS: 'WestJet', BA: 'British Airways', VS: 'Virgin Atlantic', LH: 'Lufthansa',
    AF: 'Air France', KL: 'KLM', IB: 'Iberia', EI: 'Aer Lingus', LX: 'Swiss', TP: 'TAP',
    EK: 'Emirates', QR: 'Qatar Airways', TK: 'Turkish Airlines', SQ: 'Singapore Airlines',
    CX: 'Cathay Pacific', NH: 'ANA', JL: 'JAL', QF: 'Qantas', NZ: 'Air New Zealand',
    FR: 'Ryanair', U2: 'easyJet', VY: 'Vueling', AV: 'Avianca', CM: 'Copa',
  };
  const AIRLINE_NAMES = [
    ['Delta', 'DL'], ['United', 'UA'], ['American Airlines', 'AA'], ['Southwest', 'WN'],
    ['Alaska Airlines', 'AS'], ['JetBlue', 'B6'], ['Spirit', 'NK'], ['Frontier', 'F9'],
    ['Allegiant', 'G4'], ['Hawaiian', 'HA'], ['Sun Country', 'SY'], ['Air Canada', 'AC'],
    ['WestJet', 'WS'], ['British Airways', 'BA'], ['Virgin Atlantic', 'VS'], ['Lufthansa', 'LH'],
    ['Air France', 'AF'], ['KLM', 'KL'], ['Iberia', 'IB'], ['Aer Lingus', 'EI'], ['Emirates', 'EK'],
    ['Qatar Airways', 'QR'], ['Turkish Airlines', 'TK'], ['Singapore Airlines', 'SQ'],
    ['Cathay Pacific', 'CX'], ['Qantas', 'QF'], ['Air New Zealand', 'NZ'], ['Ryanair', 'FR'],
    ['easyJet', 'U2'], ['Vueling', 'VY'], ['Avianca', 'AV'], ['Copa', 'CM'],
  ];
  const RE_FLIGHT_CODE = new RegExp('\\b(' + Object.keys(AIRLINES).join('|') + ') ?(\\d{1,4})\\b');
  const RE_FLIGHT_WORD = /\bflight\s*(?:number|no\.?|#)?\s*:?\s*(\d{1,4})\b/i;
  const ROUTE_STOP = new Set(['THE', 'AND', 'FOR', 'YOU', 'ARE', 'USD', 'EUR', 'GBP', 'CAD', 'PDT', 'PST', 'EST', 'EDT', 'CST', 'CDT', 'MST', 'MDT', 'UTC', 'GMT', 'CET', 'BST', 'NON', 'ALL']);
  const ROUTE_RES = [
    /\b([A-Z]{3})\s*(?:→|->|–|—|-|›|>|✈|to)\s*([A-Z]{3})\b/g,
    /\(([A-Z]{3})\)[^()]{0,80}?\(([A-Z]{3})\)/g,
  ];
  const CAR_BRANDS = /\b(Hertz|Avis|Enterprise|Budget|National|Alamo|Sixt|SIXT|Thrifty|Dollar|Turo|Europcar|Zipcar|Fox Rent A Car|Payless)\b/;

  function findRoute(t) {
    for (const re of ROUTE_RES) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(t))) {
        if (m[1] !== m[2] && !ROUTE_STOP.has(m[1]) && !ROUTE_STOP.has(m[2])) return { from: m[1], to: m[2] };
      }
    }
    return null;
  }

  function findFlight(t) {
    let code = '', num = '';
    const m = RE_FLIGHT_CODE.exec(t);
    if (m) { code = m[1]; num = m[2]; }
    let airline = code ? AIRLINES[code] : '';
    if (!airline) {
      for (const [name, c] of AIRLINE_NAMES) {
        if (new RegExp('\\b' + name + '\\b').test(t)) { airline = name; code = code || c; break; }
      }
    }
    if (!num) {
      const w = RE_FLIGHT_WORD.exec(t);
      if (w) num = w[1];
    }
    return { airline, code, num };
  }

  const NAME_TRIGGERS = [
    /\b(?:property|hotel|restaurant|venue|tour|activity|experience|event|attraction)(?:\s+name)?\s*:\s*/gi,
    /\b(?:stay|reservation|booking|table|visit|dinner|lunch|brunch|tickets?|tour|experience|all set|confirmed)\s+(?:at|with)\s+/gi,
    /\b(?:thanks?(?: you)? for (?:booking|choosing|reserving|staying)(?: with| at)?|welcome to|see you (?:soon )?at|look forward to (?:welcoming|seeing|hosting) you at)\s+/gi,
    /\b(?:booking|tickets?|reservation)\s+for\s+/gi,
  ];
  const PROPER_NAME = /(?:the\s+)?([A-Z][\w'’&.\-]*(?:[ ]+(?:[A-Z0-9][\w'’&.\-]*|&|of|the|de|du|la|le|del|on|at|y|by))*)/y;
  const NAME_JOINERS = /^(?:&|of|the|de|du|la|le|del|on|at|y|by)$/;
  const NAME_STOP = /^(?:your|our|this|that|the|a|an|hi|hello|dear|thank|thanks|check|confirmation|reservation|booking|details|itinerary|receipt|summary|we|you|it|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i;
  const NAME_TAIL_STOP = /^(?:reservation|confirmation|booking|receipt|details|itinerary|is|has|was|team)$/i;

  function cleanName(raw) {
    let words = raw.replace(/[.,!:;]+$/, '').split(/\s+/).slice(0, 7);
    while (words.length && (NAME_JOINERS.test(words[words.length - 1]) || NAME_TAIL_STOP.test(words[words.length - 1]))) words.pop();
    // A leading "The" is usually part of the name ("The Driskill"); greetings and "Your" are not.
    while (words.length > 1 && NAME_STOP.test(words[0]) && !/^(?:the|a|an)$/i.test(words[0])) words.shift();
    const name = words.join(' ').replace(/[.,!:;]+$/, '');
    if (!name || NAME_STOP.test(name) || name.length < 3) return '';
    return name;
  }

  function nameAfterTriggers(t) {
    for (const re of NAME_TRIGGERS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(t))) {
        PROPER_NAME.lastIndex = m.index + m[0].length;
        const n = PROPER_NAME.exec(t);
        const name = n ? cleanName(n[1]) : '';
        if (name) return name;
      }
    }
    return '';
  }

  const RE_HOTEL_NAME = /\b((?:[A-Z][\w'’&.\-]*[ ]+){0,4}(?:Hotel|Inn|Suites|Resort|Lodge|Motel|Hostel)\b(?:[ ]+(?:[A-Z][\w'’&.\-]*|&|by|at|of|the)){0,5})/g;

  function hotelName(t) {
    RE_HOTEL_NAME.lastIndex = 0;
    let m;
    while ((m = RE_HOTEL_NAME.exec(t))) {
      const name = cleanName(m[1]);
      if (name && !/^(?:Hotel|Inn|Suites|Resort|Lodge|Motel|Hostel)$/.test(name)) return name;
    }
    return '';
  }

  // ---------- type ----------

  const TYPE_HINTS = {
    flight: [/\bflights?\b/g, /\bairlines?\b/g, /\bboarding\b/g, /\bdepart(?:s|ure|ing)?\b/g, /\bgate\b/g, /\bseats?\b/g, /\brecord locator\b/g, /\be-?ticket\b/g, /\bbaggage\b/g, /\bcarry-?on\b/g],
    car: [/\brental\b/g, /\bpick-?\s?up\b/g, /\bdrop-?\s?off\b/g, /\bvehicle\b/g, /\bcar\b/g, /\b(?:hertz|avis|enterprise|alamo|sixt|thrifty|turo|europcar|zipcar)\b/g],
    hotel: [/\bhotel\b/g, /\bcheck-?\s?in\b/g, /\bcheck-?\s?out\b/g, /\brooms?\b/g, /\bnights?\b/g, /\b(?:inn|suites|resort|lodge|motel|hostel|airbnb|vrbo|marriott|hilton|hyatt)\b/g],
    dinner: [/\btable\b/g, /\bparty of\b/g, /\b(?:dinner|lunch|brunch|breakfast)\b/g, /\brestaurant\b/g, /\b(?:opentable|resy|tock|sevenrooms)\b/g, /\bcovers\b/g, /\bdining\b/g, /\bdining room\b/g],
    tour: [/\btours?\b/g, /\btickets?\b/g, /\bexperiences?\b/g, /\bactivity\b/g, /\bexcursions?\b/g, /\badmission\b/g, /\b(?:viator|getyourguide)\b/g, /\bmeeting point\b/g, /\bguided?\b/g],
  };

  function detectType(t, flight, route, carBrand) {
    const lower = t.toLowerCase();
    const scores = {};
    for (const [type, res] of Object.entries(TYPE_HINTS)) {
      scores[type] = res.reduce((sum, re) => sum + Math.min(3, (lower.match(re) || []).length), 0);
    }
    if (flight.code && flight.num) scores.flight += 4;
    if (route) scores.flight += 2;
    if (carBrand) scores.car += 3;
    let best = 'other', bestScore = 0;
    for (const [type, s] of Object.entries(scores)) {
      if (s > bestScore) { best = type; bestScore = s; }
    }
    return best;
  }

  // ---------- main ----------

  function parseBookingEmail(text, now) {
    now = now || new Date();
    const t = dropEmailHeaders(normalize(text));
    const out = { type: 'other', name: '', date: '', time: '', conf: '', address: '', phone: '', found: [] };
    if (!t) return out;

    const flight = findFlight(t);
    const route = findRoute(t);
    const carMatch = CAR_BRANDS.exec(t);
    const carBrand = carMatch ? carMatch[1] : '';
    out.type = detectType(t, flight, route, carBrand);

    const date = pickDate(t, findDates(t, now));
    out.date = date ? date.date : '';
    out.time = pickTime(t, findTimes(t), date);
    out.conf = findConf(t);
    out.phone = findPhone(t);
    const addr = findAddress(t);
    out.address = addr.address;

    if (out.type === 'flight') {
      const parts = [flight.airline, flight.num ? [flight.code, flight.num].filter(Boolean).join(' ') : ''].filter(Boolean);
      let name = parts.join(' ');
      if (route) name = name ? `${name} · ${route.from}→${route.to}` : `${route.from}→${route.to}`;
      out.name = name;
      if (!out.address && route) out.address = `${route.from} Airport`;
    } else if (out.type === 'car') {
      const brand = carBrand ? carBrand.replace(/^SIXT$/, 'Sixt') : '';
      out.name = brand ? (addr.city ? `${brand} — ${addr.city}` : brand) : nameAfterTriggers(t);
    } else {
      out.name = nameAfterTriggers(t) || (out.type === 'hotel' ? hotelName(t) : '');
    }

    out.found = ['name', 'date', 'time', 'conf', 'address', 'phone'].filter((k) => out[k]);
    return out;
  }

  root.parseBookingEmail = parseBookingEmail;
  if (typeof module !== 'undefined' && module.exports) module.exports = { parseBookingEmail };
})(typeof window !== 'undefined' ? window : globalThis);
