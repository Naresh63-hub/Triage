/* ============================================================
   TriageFLOW - app.js
   Maps: Leaflet + OpenStreetMap
   Routing: OSRM
   Hospital Search: Overpass + fast local fallback
============================================================ */

const STORAGE_KEYS = {
  patients: 'tf_patients',
  notifications: 'tf_notifications'
};

const DEFAULT_AMBULANCE = {
  lat: 17.4486,
  lng: 78.3908
};

const HOSPITALS_DB = [
  {
    id: 'fallback-1',
    name: 'Care Hospitals, Banjara Hills',
    lat: 17.4239,
    lng: 78.4483,
    address: 'Road No. 1, Banjara Hills, Hyderabad, Telangana',
    capabilities: ['cardiac', 'trauma', 'icu'],
    beds: 160,
    rating: 4.5
  },
  {
    id: 'fallback-2',
    name: 'Yashoda Hospitals, Somajiguda',
    lat: 17.4234,
    lng: 78.4566,
    address: 'Raj Bhavan Road, Somajiguda, Hyderabad, Telangana',
    capabilities: ['stroke', 'icu', 'emergency'],
    beds: 220,
    rating: 4.6
  },
  {
    id: 'fallback-3',
    name: 'KIMS Hospitals, Secunderabad',
    lat: 17.4344,
    lng: 78.4983,
    address: 'Minister Road, Secunderabad, Hyderabad, Telangana',
    capabilities: ['trauma', 'cardiac', 'neuro'],
    beds: 250,
    rating: 4.4
  },
  {
    id: 'fallback-4',
    name: 'Apollo Hospitals, Jubilee Hills',
    lat: 17.4175,
    lng: 78.4101,
    address: 'Road No. 72, Jubilee Hills, Hyderabad, Telangana',
    capabilities: ['cardiac', 'trauma', 'stroke', 'icu'],
    beds: 300,
    rating: 4.7
  },
  {
    id: 'fallback-5',
    name: 'Gandhi Hospital',
    lat: 17.4340,
    lng: 78.5034,
    address: 'Musheerabad, Secunderabad, Hyderabad, Telangana',
    capabilities: ['emergency', 'trauma'],
    beds: 180,
    rating: 4.1
  }
];

let patients = loadJson(STORAGE_KEYS.patients, []);
let notifications = loadJson(STORAGE_KEYS.notifications, []);
let currentPatient = null;
let currentAssessment = null;
let lastFoundHospitals = [];
let selectedHospital = null;
let currentTimeTab = 'today';
let pendingDestination = null;
let currentRoute = null;
let locationWatchId = null;
let hasGpsLock = false;

let ambulanceLocation = { ...DEFAULT_AMBULANCE, accuracy: null, timestamp: null };

let resultsMap = null;
let resultsMarkers = [];
let navMap = null;
let navPolyline = null;
let navAmbulanceMarker = null;
let navHospitalMarker = null;

function loadJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
  } catch (_err) {
    return fallback;
  }
}

function saveJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function persistState() {
  saveJson(STORAGE_KEYS.patients, patients);
  saveJson(STORAGE_KEYS.notifications, notifications);
}

function uid(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function fmtDate(date) {
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function clamp(num, min, max) {
  return Math.min(Math.max(num, min), max);
}

function buildHospitalAddress(tags = {}) {
  const parts = [
    tags['addr:housenumber'],
    tags['addr:street'],
    tags['addr:suburb'],
    tags['addr:neighbourhood'],
    tags['addr:city'],
    tags['addr:state'],
    tags['addr:postcode'],
    tags['addr:country']
  ].filter(Boolean);

  if (parts.length) {
    return [...new Set(parts)].join(', ');
  }

  return tags['addr:full'] || tags['contact:street'] || tags.operator || 'Address unavailable';
}

function getHospitalById(hospitalId) {
  return lastFoundHospitals.find(hospital => hospital.id === hospitalId)
    || HOSPITALS_DB.find(hospital => hospital.id === hospitalId)
    || null;
}

function getHospitalDisplayAddress(hospital) {
  if (!hospital) return 'Emergency Department';
  return hospital.address && hospital.address !== 'Address unavailable'
    ? hospital.address
    : `${hospital.name}, ${hospital.lat.toFixed(5)}, ${hospital.lng.toFixed(5)}`;
}

function getLocationSummary() {
  const coords = `${ambulanceLocation.lat.toFixed(5)}, ${ambulanceLocation.lng.toFixed(5)}`;
  if (!hasGpsLock) {
    return `GPS not locked - current fallback coordinates: ${coords}`;
  }

  const accuracyText = ambulanceLocation.accuracy ? ` (${Math.round(ambulanceLocation.accuracy)} m)` : '';
  return `GPS locked${accuracyText} - current coordinates: ${coords}`;
}

function buildGoogleMapsDirectionsUrl(hospital) {
  const destinationText = getHospitalDisplayAddress(hospital);
  const destination = encodeURIComponent(`${hospital.name}, ${destinationText}`);
  const origin = encodeURIComponent(`${ambulanceLocation.lat},${ambulanceLocation.lng}`);
  return `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}&travelmode=driving`;
}

function syncCurrentPatientDestination(hospital) {
  if (!currentPatient || !hospital) return;

  currentPatient.hospitalId = hospital.id;
  currentPatient.hospitalName = hospital.name;
  currentPatient.hospitalAddress = getHospitalDisplayAddress(hospital);
  currentPatient.hospitalLat = hospital.lat;
  currentPatient.hospitalLng = hospital.lng;
  currentPatient.etaMin = hospital.etaMin ?? currentPatient.etaMin ?? null;
}

function inferRequiredCapabilities(vitals, triage) {
  const text = `${vitals.chiefComplaint || ''} ${vitals.symptoms || ''}`.toLowerCase();
  const needs = new Set(['emergency']);

  if (triage.level === 'CRITICAL') {
    needs.add('icu');
    needs.add('trauma');
  }

  if (text.includes('chest pain') || text.includes('cardiac') || text.includes('heart')) {
    needs.add('cardiac');
  }

  if (text.includes('stroke') || text.includes('paralysis') || text.includes('speech') || text.includes('face droop')) {
    needs.add('stroke');
    needs.add('neuro');
  }

  if (text.includes('accident') || text.includes('fracture') || text.includes('bleeding') || text.includes('trauma')) {
    needs.add('trauma');
  }

  if ((vitals.spo2 ?? 100) < 90 || text.includes('breath') || text.includes('respir')) {
    needs.add('icu');
  }

  if ((vitals.gcs ?? 15) <= 8 || text.includes('unconscious') || text.includes('seizure')) {
    needs.add('icu');
    needs.add('neuro');
  }

  return [...needs];
}

function showScreen(screenName) {
  document.querySelectorAll('.screen').forEach(screen => {
    screen.classList.toggle('active', screen.id === `screen-${screenName}`);
  });

  if (screenName === 'dashboard') {
    renderDashboard();
  }

  if (screenName === 'map') {
    requestAnimationFrame(() => {
      if (navMap) {
        navMap.invalidateSize();
      } else if (selectedHospital || pendingDestination) {
        previewMap();
      }
    });
  }
}

function getVitals() {
  const readNumber = id => {
    const raw = document.getElementById(id)?.value ?? '';
    return raw === '' ? null : Number(raw);
  };

  return {
    hr: readNumber('hr'),
    sbp: readNumber('sbp'),
    dbp: readNumber('dbp'),
    rr: readNumber('rr'),
    spo2: readNumber('spo2'),
    temp: readNumber('temp'),
    gcs: readNumber('gcs'),
    bgl: readNumber('bgl'),
    chiefComplaint: (document.getElementById('chief-complaint')?.value || '').trim(),
    symptoms: (document.getElementById('symptoms')?.value || '').trim()
  };
}

function validateVitals(vitals) {
  const rules = {
    hr: { label: 'Heart rate', normal: [60, 100], warn: [50, 120], absolute: [20, 250], unit: 'bpm' },
    sbp: { label: 'Systolic BP', normal: [90, 120], warn: [80, 180], absolute: [50, 280], unit: 'mmHg' },
    dbp: { label: 'Diastolic BP', normal: [60, 80], warn: [50, 120], absolute: [30, 180], unit: 'mmHg' },
    rr: { label: 'Respiratory rate', normal: [12, 20], warn: [10, 24], absolute: [4, 70], unit: '/min' },
    spo2: { label: 'SpO2', normal: [95, 100], warn: [90, 100], absolute: [0, 100], unit: '%' },
    temp: { label: 'Temperature', normal: [36.5, 37.5], warn: [35, 39], absolute: [28, 45], unit: 'C' },
    gcs: { label: 'GCS', normal: [15, 15], warn: [9, 14], absolute: [3, 15], unit: '' },
    bgl: { label: 'Blood glucose', normal: [70, 140], warn: [60, 250], absolute: [10, 900], unit: 'mg/dL' }
  };

  const statuses = {};
  const issues = [];
  const invalidIssues = [];

  Object.entries(rules).forEach(([key, rule]) => {
    const value = vitals[key];
    if (value === null || Number.isNaN(value)) {
      statuses[key] = { level: 'empty', text: '' };
      return;
    }

    if (value < rule.absolute[0] || value > rule.absolute[1]) {
      statuses[key] = { level: 'critical', text: `Invalid ${rule.label.toLowerCase()} value` };
      const message = `${rule.label} looks unmatchable for a patient (${value}${rule.unit ? ` ${rule.unit}` : ''})`;
      issues.push(message);
      invalidIssues.push(message);
      return;
    }

    if (key === 'dbp' && vitals.sbp !== null && value >= vitals.sbp) {
      statuses[key] = { level: 'critical', text: 'Diastolic BP cannot be above systolic BP' };
      const message = 'Blood pressure values do not match a valid systolic/diastolic pattern';
      issues.push(message);
      invalidIssues.push(message);
      return;
    }

    if (value >= rule.normal[0] && value <= rule.normal[1]) {
      statuses[key] = { level: 'normal', text: 'Normal range' };
      return;
    }

    if (value >= rule.warn[0] && value <= rule.warn[1]) {
      statuses[key] = { level: 'warn', text: 'Needs attention' };
      issues.push(`${rule.label} is outside the normal range`);
      return;
    }

    statuses[key] = { level: 'critical', text: 'Critical value' };
    issues.push(`${rule.label} is critically abnormal`);
  });

  return {
    statuses,
    issues,
    invalidIssues,
    hasCriticalIssue: Object.values(statuses).some(status => status.level === 'critical'),
    hasInvalidIssue: invalidIssues.length > 0
  };
}

function predictCondition(vitals, triage, validation) {
  const text = `${vitals.chiefComplaint || ''} ${vitals.symptoms || ''}`.toLowerCase();
  const predictions = [];
  const alerts = [];

  if ((vitals.spo2 ?? 100) < 90 || text.includes('shortness of breath') || text.includes('breath')) {
    predictions.push('Respiratory distress');
    alerts.push({ level: 'high', text: 'Low oxygen pattern suggests immediate respiratory support.' });
  }

  if (text.includes('chest pain') || text.includes('left arm') || text.includes('cardiac')) {
    predictions.push('Possible cardiac emergency');
    alerts.push({ level: 'high', text: 'Symptoms align with acute coronary syndrome risk.' });
  }

  if (text.includes('stroke') || text.includes('speech') || text.includes('face droop') || text.includes('paralysis')) {
    predictions.push('Possible stroke');
    alerts.push({ level: 'high', text: 'Neurological symptoms suggest urgent stroke evaluation.' });
  }

  if ((vitals.gcs ?? 15) <= 8 || text.includes('unconscious') || text.includes('seizure')) {
    predictions.push('Neurological instability');
    alerts.push({ level: 'high', text: 'Reduced consciousness pattern needs ICU-level attention.' });
  }

  if ((vitals.temp ?? 37) > 39 || text.includes('infection') || text.includes('fever')) {
    predictions.push('Possible severe infection');
    alerts.push({ level: 'medium', text: 'Fever pattern may require sepsis screening.' });
  }

  if ((vitals.bgl ?? 100) < 60 || (vitals.bgl ?? 100) > 300) {
    predictions.push('Glucose emergency');
    alerts.push({ level: 'medium', text: 'Blood glucose is in a dangerous range.' });
  }

  if ((vitals.sbp ?? 120) < 90 || text.includes('bleeding') || text.includes('trauma')) {
    predictions.push('Shock / trauma risk');
    alerts.push({ level: 'high', text: 'Hypotension or trauma pattern may indicate shock.' });
  }

  if (!predictions.length) {
    predictions.push(triage.level === 'LOW' ? 'Stable presentation' : 'Undifferentiated acute illness');
  }

  if (validation.issues.length) {
    alerts.unshift({ level: validation.hasCriticalIssue ? 'high' : 'medium', text: validation.issues[0] });
  } else {
    alerts.push({ level: 'low', text: 'Entered vitals are internally consistent so far.' });
  }

  return {
    primary: predictions[0],
    secondary: predictions.slice(1, 3),
    alerts: alerts.slice(0, 3)
  };
}

function applyVitalFieldFeedback(validation) {
  const fieldIds = ['hr', 'sbp', 'dbp', 'rr', 'spo2', 'temp', 'gcs', 'bgl'];

  fieldIds.forEach(id => {
    const input = document.getElementById(id);
    if (!input) return;

    input.classList.remove('normal', 'warn', 'critical');
    const existingStatus = input.parentElement.querySelector('.field-status');
    if (existingStatus) existingStatus.remove();

    const status = validation.statuses[id];
    if (!status || status.level === 'empty') return;

    input.classList.add(status.level);
    const statusEl = document.createElement('div');
    statusEl.className = `field-status ${status.level}`;
    statusEl.textContent = status.text;
    input.parentElement.appendChild(statusEl);
  });
}

function computeTriage(vitals) {
  let score = 0;
  const reasons = [];

  if (vitals.gcs !== null && vitals.gcs <= 8) {
    score += 45;
    reasons.push('Very low GCS');
  } else if (vitals.gcs !== null && vitals.gcs <= 12) {
    score += 25;
    reasons.push('Reduced GCS');
  }

  if (vitals.spo2 !== null && vitals.spo2 < 90) {
    score += 40;
    reasons.push('Severe hypoxia');
  } else if (vitals.spo2 !== null && vitals.spo2 < 94) {
    score += 20;
    reasons.push('Low oxygen');
  }

  if (vitals.sbp !== null && vitals.sbp < 90) {
    score += 35;
    reasons.push('Hypotension');
  } else if (vitals.sbp !== null && vitals.sbp > 180) {
    score += 20;
    reasons.push('Severe hypertension');
  }

  if (vitals.hr !== null && (vitals.hr < 40 || vitals.hr > 140)) {
    score += 25;
    reasons.push('Unstable heart rate');
  } else if (vitals.hr !== null && (vitals.hr < 50 || vitals.hr > 120)) {
    score += 10;
  }

  if (vitals.rr !== null && (vitals.rr < 8 || vitals.rr > 30)) {
    score += 25;
    reasons.push('Critical respiratory rate');
  } else if (vitals.rr !== null && (vitals.rr < 10 || vitals.rr > 24)) {
    score += 10;
  }

  if (vitals.temp !== null && (vitals.temp < 35 || vitals.temp > 40)) {
    score += 15;
  }

  if (vitals.bgl !== null && (vitals.bgl < 60 || vitals.bgl > 300)) {
    score += 15;
  }

  const text = `${vitals.chiefComplaint} ${vitals.symptoms}`.toLowerCase();
  const dangerTerms = ['chest pain', 'stroke', 'seizure', 'unconscious', 'bleeding', 'trauma', 'cardiac'];
  if (dangerTerms.some(term => text.includes(term))) {
    score += 20;
    reasons.push('High-risk symptoms');
  }

  let level = 'LOW';
  let color = '#16a34a';
  let subtitle = 'Stable vitals with routine urgency.';

  if (score >= 80) {
    level = 'CRITICAL';
    color = '#dc2626';
    subtitle = 'Immediate life-threatening signs detected.';
  } else if (score >= 50) {
    level = 'HIGH';
    color = '#f97316';
    subtitle = 'Urgent transport recommended.';
  } else if (score >= 25) {
    level = 'MEDIUM';
    color = '#eab308';
    subtitle = 'Moderate risk. Close monitoring advised.';
  }

  return { score, level, color, subtitle, reasons };
}

function liveTriageUpdate() {
  const vitals = getVitals();
  const aiPreview = document.getElementById('ai-condition-preview');
  if (!aiPreview) return;

  const hasData = Object.entries(vitals).some(([key, value]) => key !== 'symptoms' && key !== 'chiefComplaint' ? value !== null : value);
  if (!hasData) {
    aiPreview.style.display = 'none';
    currentAssessment = null;
    applyVitalFieldFeedback({ statuses: {} });
    return;
  }

  const validation = validateVitals(vitals);
  const triage = computeTriage(vitals);
  const prediction = predictCondition(vitals, triage, validation);
  currentAssessment = { vitals, validation, triage, prediction };
  applyVitalFieldFeedback(validation);

  aiPreview.style.display = 'block';
  aiPreview.innerHTML = `
    <div class="ai-condition-grid">
      <div>
        <div style="font-family:var(--font-display);font-size:13px;font-weight:700;letter-spacing:0.6px;color:${triage.color};">
          AI CONDITION PREDICTION
        </div>
        <div style="font-family:var(--font-display);font-size:24px;font-weight:800;color:#0f172a;margin-top:6px;">
          ${escapeHtml(prediction.primary)}
        </div>
        <div style="font-size:14px;color:#475569;margin-top:6px;">
          ${escapeHtml(triage.subtitle)}
        </div>
        <div style="font-size:12px;color:#64748b;margin-top:8px;">
          ${validation.issues.length ? escapeHtml(validation.issues[0]) : 'Live monitoring is tracking each vital as you type.'}
        </div>
        <div class="ai-condition-chip-row">
          <span class="ai-condition-chip">Triage ${escapeHtml(triage.level)}</span>
          <span class="ai-condition-chip">Score ${triage.score}</span>
          ${prediction.secondary.map(item => `<span class="ai-condition-chip">${escapeHtml(item)}</span>`).join('')}
        </div>
      </div>
      <div class="ai-alert-list">
        ${prediction.alerts.map(alert => `<div class="ai-alert-item ${alert.level}">${escapeHtml(alert.text)}</div>`).join('')}
      </div>
    </div>
  `;
}

function updateRadiusIndicator(message, visible) {
  const indicator = document.getElementById('radius-indicator');
  const text = document.getElementById('radius-text');
  if (!indicator || !text) return;
  text.textContent = message;
  indicator.classList.toggle('hidden', !visible);
}

function requestLocation(onSuccess, onFail) {
  if (!navigator.geolocation) {
    hasGpsLock = false;
    onFail && onFail(new Error('Geolocation not supported'));
    return;
  }

  navigator.geolocation.getCurrentPosition(
    pos => {
      hasGpsLock = true;
      ambulanceLocation = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        timestamp: pos.timestamp
      };
      onSuccess && onSuccess(ambulanceLocation.lat, ambulanceLocation.lng, ambulanceLocation.accuracy);
    },
    err => {
      hasGpsLock = false;
      onFail && onFail(err);
    },
    {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 3000
    }
  );
}

function startLiveTracking() {
  if (!navigator.geolocation || locationWatchId !== null) return;

  locationWatchId = navigator.geolocation.watchPosition(
    pos => {
      hasGpsLock = true;
      ambulanceLocation = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        timestamp: pos.timestamp
      };
      syncNavigationPosition();
    },
    _err => {
      hasGpsLock = false;
      syncNavigationPosition();
    },
    {
      enableHighAccuracy: true,
      timeout: 12000,
      maximumAge: 3000
    }
  );
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function fetchHospitalsStepByStep(lat, lng, triageLevel) {
  const steps = triageLevel === 'CRITICAL'
    ? [2000, 5000, 10000, 20000, 35000]
    : [2000, 5000, 10000, 20000];

  let bestResults = [];

  for (const radius of steps) {
    updateRadiusIndicator(`Searching hospitals within ${(radius / 1000).toFixed(0)} km...`, true);
    try {
      const query = `
        [out:json][timeout:12];
        (
          node["amenity"="hospital"](around:${radius},${lat},${lng});
          way["amenity"="hospital"](around:${radius},${lat},${lng});
          relation["amenity"="hospital"](around:${radius},${lat},${lng});
          node["healthcare"="hospital"](around:${radius},${lat},${lng});
          way["healthcare"="hospital"](around:${radius},${lat},${lng});
          relation["healthcare"="hospital"](around:${radius},${lat},${lng});
          node["amenity"="clinic"](around:${radius},${lat},${lng});
          way["amenity"="clinic"](around:${radius},${lat},${lng});
          relation["amenity"="clinic"](around:${radius},${lat},${lng});
          node["emergency"="yes"](around:${radius},${lat},${lng});
          way["emergency"="yes"](around:${radius},${lat},${lng});
          relation["emergency"="yes"](around:${radius},${lat},${lng});
        );
        out center;
      `;

      const response = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: `data=${encodeURIComponent(query)}`
      });

      if (!response.ok) {
        throw new Error(`Overpass ${response.status}`);
      }

      const data = await response.json();
      const hospitals = (data.elements || [])
        .map((element, index) => {
          const elLat = element.lat ?? element.center?.lat;
          const elLng = element.lon ?? element.center?.lon;
          if (typeof elLat !== 'number' || typeof elLng !== 'number') return null;
          const tags = element.tags || {};
          const name = tags.name || tags.operator || tags.brand || tags['addr:housename'];
          if (!name) return null;
          return {
            id: `osm-${element.id || index}`,
            name,
            lat: elLat,
            lng: elLng,
            address: buildHospitalAddress(tags),
            capabilities: [
              'emergency',
              ...(tags.emergency === 'yes' ? ['trauma'] : []),
              ...(tags.healthcare === 'hospital' ? ['icu'] : [])
            ],
            beds: 100,
            rating: 4.0,
            isReal: true,
            source: 'live'
          };
        })
        .filter(Boolean);

      const uniqueHospitals = [];
      const seen = new Set();

      hospitals.forEach(hospital => {
        const key = `${hospital.name.trim().toLowerCase()}|${hospital.lat.toFixed(4)}|${hospital.lng.toFixed(4)}`;
        if (!seen.has(key)) {
          seen.add(key);
          uniqueHospitals.push(hospital);
        }
      });

      if (uniqueHospitals.length > bestResults.length) {
        bestResults = uniqueHospitals;
      }

      if (uniqueHospitals.length >= 10) {
        break;
      }
    } catch (err) {
      console.warn('Hospital search failed for radius', radius, err);
    }
  }

  updateRadiusIndicator('Using best available hospital matches.', false);
  return bestResults;
}

function mergeHospitals(realHospitals) {
  const liveHospitals = realHospitals.map(hospital => ({ ...hospital, source: 'live' }));
  const unique = new Map();
  liveHospitals.forEach(hospital => {
    const key = hospital.name.trim().toLowerCase();
    if (!unique.has(key)) {
      unique.set(key, hospital);
    }
  });
  return [...unique.values()];
}

function scoreHospitalForTriage(hospital, triage) {
  let score = 100;
  const caps = hospital.capabilities || [];

  if (triage.level === 'CRITICAL') {
    score += caps.includes('icu') ? 25 : 0;
    score += caps.includes('trauma') ? 20 : 0;
    score += caps.includes('cardiac') ? 12 : 0;
    score += hospital.rating * 3;
  } else if (triage.level === 'HIGH') {
    score += caps.includes('emergency') ? 18 : 0;
    score += caps.includes('stroke') ? 10 : 0;
    score += hospital.rating * 3;
  } else {
    score += hospital.rating * 2;
  }

  return score;
}

function computeHospitalRank(hospital, triage, vitals, distKm) {
  const neededCaps = inferRequiredCapabilities(vitals, triage);
  const caps = hospital.capabilities || [];
  const matchedCaps = neededCaps.filter(capability => caps.includes(capability)).length;
  const sourceBonus = hospital.source === 'live' ? 35 : 0;
  const distancePenalty = triage.level === 'CRITICAL' ? distKm * 5 : distKm * 8;
  const nearbyBoost = distKm <= 3 ? 30 : distKm <= 7 ? 18 : distKm <= 12 ? 8 : 0;
  const capabilityBoost = matchedCaps * 18;
  const baseScore = scoreHospitalForTriage(hospital, triage);

  return {
    score: baseScore + sourceBonus + nearbyBoost + capabilityBoost - distancePenalty,
    matchedCaps,
    neededCaps
  };
}

function triageClass(level) {
  return level === 'CRITICAL' ? 'match-low' : level === 'HIGH' ? 'match-medium' : 'match-high';
}

function renderHospitalResults(triage, vitals, hospitals) {
  if (!hospitals.length) {
    lastFoundHospitals = [];
    selectedHospital = null;

    document.getElementById('results-triage-banner').innerHTML = `
      <div class="assignment-card" style="margin-top:0;">
        <div style="font-family:var(--font-display);font-size:18px;font-weight:700;color:#0f172a;">No Nearby Live Hospitals Found</div>
        <div style="font-size:14px;color:#475569;margin-top:8px;">
          No live nearby hospitals were returned for your current GPS location. Try again with stronger location accuracy or a wider search area.
        </div>
      </div>
    `;
    document.getElementById('results-subtitle').textContent =
      `${getLocationSummary()} - no live nearby hospitals found for this search`;
    document.getElementById('hospital-result-list').innerHTML = '';
    document.getElementById('assignment-section').classList.add('hidden');
    document.getElementById('results-map-card').classList.add('hidden');
    return;
  }

  const previousSelectionId = selectedHospital?.id;
  const previousPatientId = currentPatient?.id;
  const processed = hospitals.map(hospital => {
    const distKm = haversineKm(ambulanceLocation.lat, ambulanceLocation.lng, hospital.lat, hospital.lng);
    const avgSpeedKmPerMin = triage.level === 'CRITICAL' ? 0.95 : triage.level === 'HIGH' ? 0.75 : 0.55;
    const etaMin = Math.max(1, Math.round(distKm / avgSpeedKmPerMin));
    const ranking = computeHospitalRank(hospital, triage, vitals, distKm);
    return { ...hospital, distKm, etaMin, score: ranking.score, matchedCaps: ranking.matchedCaps, neededCaps: ranking.neededCaps };
  });

  const sorted = processed.sort((a, b) => {
    if (a.source === 'live' && b.source !== 'live') return -1;
    if (b.source === 'live' && a.source !== 'live') return 1;
    if (Math.abs(a.distKm - b.distKm) <= 1.5) return b.score - a.score;
    return a.distKm - b.distKm;
  });

  lastFoundHospitals = sorted;
  selectedHospital = sorted.find(hospital => hospital.id === previousSelectionId) || sorted[0] || null;
  currentPatient = {
    id: previousPatientId || uid('PT'),
    createdAt: new Date().toISOString(),
    vitals,
    triage,
    ambulanceLocation: { ...ambulanceLocation },
    hospitalId: null,
    hospitalName: null,
    hospitalAddress: null,
    hospitalLat: null,
    hospitalLng: null,
    etaMin: null,
    status: 'draft'
  };
  syncCurrentPatientDestination(selectedHospital);

  const triageBanner = document.getElementById('results-triage-banner');
  triageBanner.innerHTML = `
    <div class="assignment-card" style="margin-top:0;background:${triage.color}12;border-color:${triage.color}33;">
      <div style="display:flex;justify-content:space-between;gap:16px;align-items:center;flex-wrap:wrap;">
        <div>
          <div style="font-family:var(--font-display);font-size:12px;font-weight:700;letter-spacing:0.6px;color:${triage.color};">
            TRIAGE RESULT
          </div>
          <div style="font-family:var(--font-display);font-size:26px;font-weight:800;color:#0f172a;">
            ${triage.level}
          </div>
          <div style="font-size:14px;color:#475569;">
            ${escapeHtml(triage.subtitle)}
          </div>
        </div>
        <div style="text-align:right;">
          <div style="font-family:var(--font-mono);font-size:28px;font-weight:700;color:#0f172a;">${triage.score}</div>
          <div style="font-size:12px;color:#64748b;">Severity Score</div>
        </div>
      </div>
    </div>
  `;

  document.getElementById('results-subtitle').textContent =
    `${getLocationSummary()} - nearby hospitals ranked by distance and condition`;

  const list = document.getElementById('hospital-result-list');
  list.innerHTML = '';

  sorted.forEach((hospital, index) => {
    const card = document.createElement('div');
    card.className = `hospital-result-card${selectedHospital?.id === hospital.id ? ' selected' : ''}`;
    card.onclick = () => selectHospital(hospital.id);

    card.innerHTML = `
      <div class="radio-circle ${selectedHospital?.id === hospital.id ? 'checked' : ''}"></div>
      <div style="flex:1;min-width:0;">
        <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap;">
          <div>
            <h3 style="font-family:var(--font-display);font-size:18px;color:#0f172a;">${escapeHtml(hospital.name)}</h3>
            <p style="font-size:13px;color:#64748b;margin-top:4px;">${escapeHtml(hospital.address || 'Emergency Department')}</p>
          </div>
          <div class="match-pill ${triageClass(triage.level)}">${index === 0 ? 'Best Match' : `Rank #${index + 1}`}</div>
        </div>
        <div style="display:flex;gap:18px;flex-wrap:wrap;margin-top:14px;font-size:14px;color:#334155;">
          <span>${hospital.distKm.toFixed(1)} km away</span>
          <span>${hospital.etaMin} min ETA</span>
          <span>${hospital.matchedCaps}/${hospital.neededCaps.length} condition match</span>
          <span>Live nearby</span>
        </div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:14px;">
          <button class="table-action-btn" onclick="event.stopPropagation(); previewMap('${hospital.id}')">Preview Route</button>
          <button class="table-action-btn" onclick="event.stopPropagation(); navigateTo('${hospital.id}')">Navigate</button>
        </div>
      </div>
    `;

    list.appendChild(card);
  });

  document.getElementById('assignment-section').classList.toggle('hidden', sorted.length === 0);
  document.getElementById('eta').value = selectedHospital?.etaMin || 15;

  renderResultsMap();
}

function selectHospital(hospitalId) {
  selectedHospital = lastFoundHospitals.find(hospital => hospital.id === hospitalId) || null;
  if (!selectedHospital || !currentPatient) return;
  syncCurrentPatientDestination(selectedHospital);
  document.getElementById('eta').value = selectedHospital.etaMin || 15;
  renderHospitalResults(currentPatient.triage, currentPatient.vitals, lastFoundHospitals);
}

function ensureResultsMap() {
  const mapCard = document.getElementById('results-map-card');
  mapCard.classList.remove('hidden');

  if (!resultsMap) {
    resultsMap = L.map('results-map', { zoomControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(resultsMap);
  }

  requestAnimationFrame(() => resultsMap.invalidateSize());
  return resultsMap;
}

function renderResultsMap() {
  if (!lastFoundHospitals.length) return;

  const map = ensureResultsMap();
  resultsMarkers.forEach(marker => marker.remove());
  resultsMarkers = [];

  const ambulanceMarker = L.marker([ambulanceLocation.lat, ambulanceLocation.lng]).bindPopup('Ambulance location');
  ambulanceMarker.addTo(map);
  resultsMarkers.push(ambulanceMarker);

  lastFoundHospitals.slice(0, 8).forEach(hospital => {
    const marker = L.marker([hospital.lat, hospital.lng]).bindPopup(`
      <strong>${escapeHtml(hospital.name)}</strong><br>
      ${escapeHtml(getHospitalDisplayAddress(hospital))}<br>
      ${hospital.distKm.toFixed(1)} km - ${hospital.etaMin} min
    `);
    marker.addTo(map);
    resultsMarkers.push(marker);
  });

  const bounds = L.latLngBounds([
    [ambulanceLocation.lat, ambulanceLocation.lng],
    ...lastFoundHospitals.slice(0, 8).map(hospital => [hospital.lat, hospital.lng])
  ]);
  map.fitBounds(bounds.pad(0.2));
}

async function submitPatientForm(event) {
  event.preventDefault();
  const assessment = currentAssessment || (() => {
    const vitals = getVitals();
    const validation = validateVitals(vitals);
    const triage = computeTriage(vitals);
    const prediction = predictCondition(vitals, triage, validation);
    return { vitals, validation, triage, prediction };
  })();
  const { vitals, validation, triage } = assessment;

  if (validation.hasInvalidIssue) {
    showScreen('ambulance');
    liveTriageUpdate();
    const aiPreview = document.getElementById('ai-condition-preview');
    if (aiPreview) {
      aiPreview.style.display = 'block';
      aiPreview.innerHTML = `
        <div class="ai-alert-list">
          ${validation.invalidIssues.map(issue => `<div class="ai-alert-item high">${escapeHtml(issue)}</div>`).join('')}
        </div>
      `;
    }
    return;
  }

  showScreen('hospitals');
  updateRadiusIndicator('Getting precise GPS location...', true);

  const fetchAndRender = async () => {
    try {
      const realHospitals = await fetchHospitalsStepByStep(
        ambulanceLocation.lat,
        ambulanceLocation.lng,
        triage.level
      );
      renderHospitalResults(triage, vitals, mergeHospitals(realHospitals));
    } catch (_err) {
      renderHospitalResults(triage, vitals, []);
    } finally {
      updateRadiusIndicator('', false);
      startLiveTracking();
    }
  };

  requestLocation(
    async () => { await fetchAndRender(); },
    async () => {
      updateRadiusIndicator('Location permission is required to show nearby hospitals from your GPS.', true);
      document.getElementById('results-subtitle').textContent =
        'Location not available - allow GPS access to search nearby hospitals around you';
      document.getElementById('hospital-result-list').innerHTML = `
        <div class="assignment-card" style="margin-top:0;">
          <div style="font-family:var(--font-display);font-size:18px;font-weight:700;color:#0f172a;">Location Required</div>
          <div style="font-size:14px;color:#475569;margin-top:8px;">
            This search needs your real GPS location. Please allow location access in the browser and try again.
          </div>
        </div>
      `;
      document.getElementById('results-triage-banner').innerHTML = '';
      document.getElementById('assignment-section').classList.add('hidden');
      document.getElementById('results-map-card').classList.add('hidden');
    }
  );
}

async function fetchRoute(origin, destination) {
  const url = `https://router.project-osrm.org/route/v1/driving/${origin.lng},${origin.lat};${destination.lng},${destination.lat}?overview=full&geometries=geojson`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Routing failed with ${response.status}`);
  }

  const data = await response.json();
  const route = data.routes?.[0];
  if (!route) {
    throw new Error('No route returned');
  }

  return {
    distanceKm: route.distance / 1000,
    durationMin: Math.max(1, Math.round(route.duration / 60)),
    coordinates: route.geometry.coordinates.map(([lng, lat]) => [lat, lng])
  };
}

function ensureNavMap() {
  if (!navMap) {
    navMap = L.map('map', { zoomControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(navMap);
  }
  requestAnimationFrame(() => navMap.invalidateSize());
  return navMap;
}

async function previewMap(hospitalId) {
  if (hospitalId) {
    selectedHospital = lastFoundHospitals.find(hospital => hospital.id === hospitalId) || selectedHospital;
  }

  if (!selectedHospital) return;

  pendingDestination = { ...selectedHospital };
  syncCurrentPatientDestination(selectedHospital);
  showScreen('map');
  startLiveTracking();

  document.getElementById('route-status-text').textContent = 'Loading fastest route...';
  document.getElementById('map-dest-name').textContent = selectedHospital.name;
  document.getElementById('map-dest-addr').textContent = getHospitalDisplayAddress(selectedHospital);
  document.getElementById('map-prio').textContent = currentPatient?.triage?.level || '-';
  document.getElementById('map-eta').textContent = '--';
  document.getElementById('map-dist').textContent = '--';

  const map = ensureNavMap();

  try {
    currentRoute = await fetchRoute(ambulanceLocation, selectedHospital);

    if (navPolyline) navPolyline.remove();
    if (navAmbulanceMarker) navAmbulanceMarker.remove();
    if (navHospitalMarker) navHospitalMarker.remove();

    navPolyline = L.polyline(currentRoute.coordinates, {
      color: '#2563eb',
      weight: 5,
      opacity: 0.85
    }).addTo(map);

    navAmbulanceMarker = L.marker([ambulanceLocation.lat, ambulanceLocation.lng]).addTo(map);
    navHospitalMarker = L.marker([selectedHospital.lat, selectedHospital.lng]).addTo(map);

    map.fitBounds(navPolyline.getBounds().pad(0.15));

    document.getElementById('route-status-text').textContent =
      `Live route ready${ambulanceLocation.accuracy ? ` (${Math.round(ambulanceLocation.accuracy)} m GPS)` : ''}`;
    document.getElementById('map-eta').textContent = currentRoute.durationMin;
    document.getElementById('map-dist').textContent = `${currentRoute.distanceKm.toFixed(1)} km`;

    if (currentPatient) {
      currentPatient.etaMin = currentRoute.durationMin;
      currentPatient.routeDistanceKm = currentRoute.distanceKm;
    }
  } catch (_err) {
    const fallbackDist = haversineKm(ambulanceLocation.lat, ambulanceLocation.lng, selectedHospital.lat, selectedHospital.lng);
    const fallbackEta = Math.max(1, Math.round(fallbackDist / 0.7));

    if (navPolyline) navPolyline.remove();
    navPolyline = L.polyline([
      [ambulanceLocation.lat, ambulanceLocation.lng],
      [selectedHospital.lat, selectedHospital.lng]
    ], {
      color: '#2563eb',
      weight: 4,
      dashArray: '10,8'
    }).addTo(map);

    if (navAmbulanceMarker) navAmbulanceMarker.remove();
    if (navHospitalMarker) navHospitalMarker.remove();
    navAmbulanceMarker = L.marker([ambulanceLocation.lat, ambulanceLocation.lng]).addTo(map);
    navHospitalMarker = L.marker([selectedHospital.lat, selectedHospital.lng]).addTo(map);
    map.fitBounds(navPolyline.getBounds().pad(0.2));

    document.getElementById('route-status-text').textContent = 'Route service unavailable. Using direct GPS line.';
    document.getElementById('map-eta').textContent = fallbackEta;
    document.getElementById('map-dist').textContent = `${fallbackDist.toFixed(1)} km`;
  }
}

function syncNavigationPosition() {
  if (!navMap || !pendingDestination) return;

  if (navAmbulanceMarker) {
    navAmbulanceMarker.setLatLng([ambulanceLocation.lat, ambulanceLocation.lng]);
  }

  const directDist = haversineKm(
    ambulanceLocation.lat,
    ambulanceLocation.lng,
    pendingDestination.lat,
    pendingDestination.lng
  );

  const eta = currentRoute?.distanceKm
    ? Math.max(1, Math.round((directDist / Math.max(currentRoute.distanceKm, 0.1)) * currentRoute.durationMin))
    : Math.max(1, Math.round(directDist / 0.7));

  document.getElementById('map-dist').textContent = `${directDist.toFixed(1)} km`;
  document.getElementById('map-eta').textContent = eta;
  document.getElementById('route-status-text').textContent =
    `Tracking live${ambulanceLocation.accuracy ? ` (${Math.round(ambulanceLocation.accuracy)} m accuracy)` : ''}`;
}

function navigateTo(hospitalId) {
  const hospital = getHospitalById(hospitalId)
    || (currentPatient?.hospitalLat && currentPatient?.hospitalLng ? {
      id: currentPatient.hospitalId || 'saved-destination',
      name: currentPatient.hospitalName || 'Hospital',
      address: currentPatient.hospitalAddress || 'Emergency Department',
      lat: currentPatient.hospitalLat,
      lng: currentPatient.hospitalLng
    } : null)
    || selectedHospital;
  if (!hospital) return;

  pendingDestination = { ...hospital };
  const url = buildGoogleMapsDirectionsUrl(hospital);
  window.open(url, '_blank', 'noopener');
}

function openGoogleMaps() {
  if (!pendingDestination) return;
  navigateTo(pendingDestination.id);
}

function sendPatientToHospital() {
  if (!currentPatient || !selectedHospital) return;

  const crewId = (document.getElementById('crew-id')?.value || '').trim() || 'AMB-001';
  const eta = Math.max(1, Number(document.getElementById('eta')?.value || currentPatient.etaMin || 15));
  const now = new Date();

  currentPatient = {
    ...currentPatient,
    crewId,
    etaMin: eta,
    assignedAt: now.toISOString(),
    status: 'enroute'
  };
  syncCurrentPatientDestination(selectedHospital);

  patients.unshift(currentPatient);
  notifications.unshift({
    id: uid('NTF'),
    patientId: currentPatient.id,
    hospitalName: selectedHospital.name,
    status: 'enroute',
    createdAt: now.toISOString(),
    crewId,
    etaMin: eta
  });

  persistState();
  renderConfirmScreen();
  renderDashboard();
  showScreen('confirm');
}

function renderConfirmScreen() {
  const details = document.getElementById('confirm-details');
  if (!details || !currentPatient) return;

  details.innerHTML = `
    <div class="confirm-detail-row"><dt>Patient ID</dt><dd>${escapeHtml(currentPatient.id)}</dd></div>
    <div class="confirm-detail-row"><dt>Triage</dt><dd>${escapeHtml(currentPatient.triage.level)}</dd></div>
    <div class="confirm-detail-row"><dt>Hospital</dt><dd>${escapeHtml(currentPatient.hospitalName || '-')}</dd></div>
    <div class="confirm-detail-row"><dt>Address</dt><dd>${escapeHtml(currentPatient.hospitalAddress || '-')}</dd></div>
    <div class="confirm-detail-row"><dt>Crew</dt><dd>${escapeHtml(currentPatient.crewId)}</dd></div>
    <div class="confirm-detail-row"><dt>ETA</dt><dd>${currentPatient.etaMin} min</dd></div>
    <div class="confirm-detail-row"><dt>Assigned</dt><dd>${escapeHtml(fmtDate(new Date(currentPatient.assignedAt)))}</dd></div>
  `;
}

function startNewPatient() {
  currentPatient = null;
  currentAssessment = null;
  lastFoundHospitals = [];
  selectedHospital = null;
  pendingDestination = null;
  currentRoute = null;

  document.getElementById('patient-form')?.reset();
  document.getElementById('ai-condition-preview').style.display = 'none';
  document.getElementById('hospital-result-list').innerHTML = '';
  document.getElementById('results-triage-banner').innerHTML = '';
  document.getElementById('assignment-section').classList.add('hidden');
  document.getElementById('results-map-card').classList.add('hidden');
  showScreen('ambulance');
}

function getTabKey(dateString) {
  const target = new Date(dateString);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const sample = new Date(target.getFullYear(), target.getMonth(), target.getDate());

  if (sample.getTime() === today.getTime()) return 'today';
  if (sample.getTime() === yesterday.getTime()) return 'yesterday';
  return 'older';
}

function setTimeTab(tab) {
  currentTimeTab = tab;
  document.querySelectorAll('.time-tab').forEach(button => {
    button.classList.toggle('active', button.dataset.tab === tab);
  });
  renderDashboard();
}

function updateTabBadges() {
  const counts = { today: 0, yesterday: 0, older: 0 };
  patients.forEach(patient => {
    counts[getTabKey(patient.assignedAt || patient.createdAt)] += 1;
  });

  document.getElementById('tab-today-badge').textContent = counts.today;
  document.getElementById('tab-yesterday-badge').textContent = counts.yesterday;
  document.getElementById('tab-older-badge').textContent = counts.older;
}

function renderDashboard() {
  updateTabBadges();
  populateHospitalFilter();

  const prioFilter = document.getElementById('prio-filter')?.value || 'all';
  const searchFilter = (document.getElementById('search-filter')?.value || '').trim().toLowerCase();
  const hospFilter = document.getElementById('hosp-filter')?.value || 'all';

  const filtered = patients.filter(patient => {
    const tabKey = getTabKey(patient.assignedAt || patient.createdAt);
    if (currentTimeTab !== 'all' && tabKey !== currentTimeTab) return false;
    if (prioFilter !== 'all' && patient.triage.level.toLowerCase() !== prioFilter) return false;
    if (hospFilter !== 'all' && patient.hospitalName !== hospFilter) return false;

    if (searchFilter) {
      const haystack = `${patient.id} ${patient.vitals.chiefComplaint} ${patient.hospitalName}`.toLowerCase();
      if (!haystack.includes(searchFilter)) return false;
    }

    return true;
  });

  const tbody = document.getElementById('patient-tbody');
  tbody.innerHTML = filtered.length ? '' : `
    <tr><td colspan="8" style="padding:24px;color:#64748b;">No patients match the current filters.</td></tr>
  `;

  filtered.forEach(patient => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td><span class="priority-badge prio-${patient.triage.level}">${patient.triage.level}</span></td>
      <td>${escapeHtml(patient.id)}</td>
      <td>${escapeHtml(fmtDate(new Date(patient.assignedAt || patient.createdAt)))}</td>
      <td>${escapeHtml(patient.vitals.chiefComplaint || '-')}</td>
      <td>${patient.vitals.hr ?? '-'}</td>
      <td>${patient.vitals.sbp ?? '-'}/${patient.vitals.dbp ?? '-'}</td>
      <td>${patient.vitals.spo2 ?? '-'}</td>
      <td><button class="table-action-btn" onclick="openPatientModal('${patient.id}')">View</button></td>
    `;
    tbody.appendChild(row);
  });

  renderIncomingList();
}

function populateHospitalFilter() {
  const select = document.getElementById('hosp-filter');
  if (!select) return;

  const currentValue = select.value || 'all';
  const hospitals = [...new Set(patients.map(patient => patient.hospitalName).filter(Boolean))].sort();
  select.innerHTML = '<option value="all">All Hospitals</option>';
  hospitals.forEach(name => {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    select.appendChild(option);
  });
  select.value = hospitals.includes(currentValue) || currentValue === 'all' ? currentValue : 'all';
}

function renderIncomingList() {
  const list = document.getElementById('incoming-list');
  if (!list) return;

  const incoming = patients.filter(patient => patient.status === 'enroute').slice(0, 10);
  list.innerHTML = incoming.length ? '' : '<div style="color:#64748b;">No active en-route patients right now.</div>';

  incoming.forEach(patient => {
    const card = document.createElement('div');
    card.className = 'incoming-card';
    card.innerHTML = `
      <div class="incoming-top">
        <div>
          <div style="font-family:var(--font-display);font-size:17px;font-weight:700;color:#0f172a;">${escapeHtml(patient.id)}</div>
          <div style="font-size:14px;color:#64748b;">${escapeHtml(patient.hospitalName || 'Unassigned')} - ETA ${patient.etaMin || '-'} min</div>
        </div>
        <span class="status-pill ${patient.status === 'arrived' ? 'status-arrived' : 'status-enroute'}">${patient.status.toUpperCase()}</span>
      </div>
      <div style="font-size:14px;color:#334155;">${escapeHtml(patient.vitals.chiefComplaint || 'No complaint entered')}</div>
      <div class="incoming-actions">
        <button class="act-btn act-btn-view" onclick="openPatientModal('${patient.id}')">View Details</button>
        <button class="act-btn act-btn-arrive" onclick="markArrived('${patient.id}')">Mark Arrived</button>
      </div>
    `;
    list.appendChild(card);
  });
}

function openPatientModal(patientId) {
  const patient = patients.find(item => item.id === patientId);
  if (!patient) return;

  document.getElementById('modal-patient-title').textContent = `Patient ${patient.id}`;
  document.getElementById('modal-body').innerHTML = `
    <div style="display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;">
      <div>
        <div style="font-size:12px;font-weight:700;letter-spacing:0.6px;color:#2563eb;">TRIAGE</div>
        <div style="font-family:var(--font-display);font-size:24px;font-weight:800;color:#0f172a;">${escapeHtml(patient.triage.level)}</div>
      </div>
      <div style="text-align:right;">
        <div style="font-size:12px;font-weight:700;letter-spacing:0.6px;color:#64748b;">DESTINATION</div>
        <div style="font-family:var(--font-display);font-size:18px;font-weight:700;color:#0f172a;">${escapeHtml(patient.hospitalName || '-')}</div>
      </div>
    </div>
    <div style="margin-top:18px;font-size:14px;color:#475569;">
      <strong>Chief complaint:</strong> ${escapeHtml(patient.vitals.chiefComplaint || '-')}<br>
      <strong>Symptoms:</strong> ${escapeHtml(patient.vitals.symptoms || '-')}<br>
      <strong>Assigned:</strong> ${escapeHtml(fmtDate(new Date(patient.assignedAt || patient.createdAt)))}
    </div>
    <div class="vitals-modal-grid">
      ${renderVitalChip('Heart Rate', patient.vitals.hr, 'bpm')}
      ${renderVitalChip('BP', patient.vitals.sbp !== null ? `${patient.vitals.sbp}/${patient.vitals.dbp ?? '-'}` : '-', 'mmHg')}
      ${renderVitalChip('SpO2', patient.vitals.spo2, '%')}
      ${renderVitalChip('Resp Rate', patient.vitals.rr, '/min')}
      ${renderVitalChip('Temp', patient.vitals.temp, 'C')}
      ${renderVitalChip('GCS', patient.vitals.gcs, '')}
      ${renderVitalChip('BGL', patient.vitals.bgl, 'mg/dL')}
    </div>
  `;

  document.getElementById('patient-modal').classList.add('open');
}

function renderVitalChip(label, value, unit) {
  return `
    <div class="vital-chip">
      <div class="vital-chip-label">${escapeHtml(label)}</div>
      <div class="vital-chip-value">${value ?? '-'}</div>
      <div class="vital-chip-unit">${escapeHtml(unit)}</div>
    </div>
  `;
}

function closeModal() {
  document.getElementById('patient-modal').classList.remove('open');
}

function handleModalClick(event) {
  if (event.target.id === 'patient-modal') {
    closeModal();
  }
}

function markArrived(patientId) {
  const patient = patients.find(item => item.id === patientId);
  if (!patient) return;
  patient.status = 'arrived';
  patient.arrivedAt = new Date().toISOString();
  notifications.unshift({
    id: uid('NTF'),
    patientId,
    hospitalName: patient.hospitalName,
    status: 'arrived',
    createdAt: patient.arrivedAt,
    crewId: patient.crewId,
    etaMin: 0
  });
  persistState();
  renderDashboard();
}

document.addEventListener('DOMContentLoaded', () => {
  showScreen('home');
  liveTriageUpdate();
  renderDashboard();
  startLiveTracking();
});

window.showScreen = showScreen;
window.submitPatientForm = submitPatientForm;
window.liveTriageUpdate = liveTriageUpdate;
window.sendPatientToHospital = sendPatientToHospital;
window.previewMap = previewMap;
window.openGoogleMaps = openGoogleMaps;
window.startNewPatient = startNewPatient;
window.setTimeTab = setTimeTab;
window.renderDashboard = renderDashboard;
window.handleModalClick = handleModalClick;
window.closeModal = closeModal;
window.navigateTo = navigateTo;
window.openPatientModal = openPatientModal;
window.markArrived = markArrived;
