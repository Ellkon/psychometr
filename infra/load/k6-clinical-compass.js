// k6 load scenario for «Клинический компас» (NFR-3). Synthetic data only, isolated stand only.
//
//   docker run --rm --network host -v "$PWD/infra/load:/load:ro" \
//     -e BASE_URL=https://localhost:8443 -e ADMIN_EMAIL=... -e ADMIN_PASSWORD=... \
//     grafana/k6:1.3.0 run /load/k6-clinical-compass.js
//
// Setup signs in once per account (the login limit is 10/min per IP), creates doctors and
// patients through the real invitation flow, then two scenarios run in parallel:
// doctors open the registry and patient views; patients answer PHQ-9 (with a retry of the same
// submission), mark doses (with a repeat) and read their data. Checks cover idempotency: a retry
// must return the stored result, never a duplicate or a server error.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'https://localhost:8443';
const DOCTORS = Number(__ENV.DOCTORS || 3);
const PATIENTS_PER_DOCTOR = Number(__ENV.PATIENTS_PER_DOCTOR || 5);
const VUS = Number(__ENV.VUS || 20);
const DURATION = __ENV.DURATION || '2m';

const serverErrors = new Counter('server_errors');

export const options = {
  insecureSkipTLSVerify: true,
  setupTimeout: '120s',
  scenarios: {
    doctors: {
      executor: 'constant-vus',
      exec: 'doctorFlow',
      vus: Math.max(1, Math.floor(VUS / 4)),
      duration: DURATION,
    },
    patients: {
      executor: 'constant-vus',
      exec: 'patientFlow',
      vus: Math.max(1, VUS - Math.floor(VUS / 4)),
      duration: DURATION,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
    'http_req_duration{scenario:doctors}': ['p(95)<800'],
    'http_req_duration{scenario:patients}': ['p(95)<500'],
    server_errors: ['count==0'],
  },
};

const json = (token) => ({
  headers: {
    'Content-Type': 'application/json',
    Origin: BASE,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  },
});

function post(path, body, token, name) {
  const response = http.post(`${BASE}${path}`, JSON.stringify(body), {
    ...json(token),
    tags: { name: name || path },
  });
  if (response.status >= 500) serverErrors.add(1);
  return response;
}

function get(path, token, name) {
  const response = http.get(`${BASE}${path}`, { ...json(token), tags: { name: name || path } });
  if (response.status >= 500) serverErrors.add(1);
  return response;
}

function put(path, body, token, name) {
  const response = http.put(`${BASE}${path}`, JSON.stringify(body), {
    ...json(token),
    tags: { name: name || path },
  });
  if (response.status >= 500) serverErrors.add(1);
  return response;
}

function uuid() {
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 32; i++) {
    let digit = Math.floor(Math.random() * 16);
    if (i === 12) digit = 4;
    if (i === 16) digit = (digit & 0x3) | 0x8;
    out += hex[digit];
    if (i === 7 || i === 11 || i === 15 || i === 19) out += '-';
  }
  return out;
}

const code6 = () => String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');

export function setup() {
  const admin = post(
    '/api/auth/login',
    { email: __ENV.ADMIN_EMAIL, password: __ENV.ADMIN_PASSWORD },
    null,
    'setup',
  );
  if (admin.status !== 200) throw new Error(`admin login ${admin.status}`);
  const adminToken = admin.json('accessToken');
  const consentVersion = get('/api/auth/consent', null, 'setup').json('version');

  // A dose in 30 minutes (UTC) is markable now: the window opens an hour before the dose.
  const due = new Date(Date.now() + 30 * 60_000);
  const doseTime = due.toISOString().slice(11, 16);
  const doseDay = due.toISOString().slice(0, 10);

  const doctors = [];
  const patients = [];
  for (let d = 0; d < DOCTORS; d++) {
    const email = `load-${uuid()}@example.test`;
    const password = `Load-${uuid()}`;
    const created = post('/api/admin/practitioners', { email, password }, adminToken, 'setup');
    if (created.status !== 201) throw new Error(`doctor create ${created.status}`);
    const login = post('/api/auth/login', { email, password }, null, 'setup');
    if (login.status !== 200) throw new Error(`doctor login ${login.status}`);
    const doctor = { token: login.json('accessToken'), patients: [] };
    for (let p = 0; p < PATIENTS_PER_DOCTOR; p++) {
      const patient = post(
        '/api/patients',
        {
          identity: {
            firstName: 'Нагрузка',
            lastName: 'Синтетическая',
            middleName: null,
            phone: '+70000000000',
            birthDate: '2000-01-01',
            snils: null,
          },
        },
        doctor.token,
        'setup',
      );
      if (patient.status !== 201) throw new Error(`patient create ${patient.status}`);
      const patientId = patient.json('id');
      put(
        `/api/patients/${patientId}/scales/phq9/schedule`,
        { intervalDays: 1, windowDays: 1, active: true },
        doctor.token,
        'setup',
      );
      const medication = post(
        `/api/patients/${patientId}/medications`,
        {
          grlsRegNumber: null,
          drugText: 'Синтетический препарат',
          doseText: '1 таблетка',
          doseTimes: [doseTime],
          timeZone: 'UTC',
          startsOn: doseDay,
          endsOn: null,
        },
        doctor.token,
        'setup',
      );
      const invite = post(`/api/patients/${patientId}/invites`, {}, doctor.token, 'setup');
      if (invite.status !== 201) throw new Error(`invite ${invite.status}`);
      const token = invite.json('url').split('/i/')[1];
      const accepted = post(
        '/api/auth/invites/accept',
        {
          token,
          code: invite.json('code'),
          personalCode: code6(),
          consentVersion,
          consentAccepted: true,
        },
        null,
        'setup',
      );
      if (accepted.status !== 200) throw new Error(`invite accept ${accepted.status}`);
      doctor.patients.push(patientId);
      patients.push({
        id: patientId,
        token: accepted.json('accessToken'),
        medicationId: medication.json('id'),
        slot: `${doseDay}T${doseTime}:00.000Z`,
      });
    }
    doctors.push(doctor);
  }
  return { doctors, patients };
}

export function doctorFlow(data) {
  const doctor = data.doctors[(__VU - 1) % data.doctors.length];
  const registry = get('/api/registry?offset=0&limit=20', doctor.token, 'registry');
  check(registry, { 'registry 200': (r) => r.status === 200 });
  const patientId = doctor.patients[Math.floor(Math.random() * doctor.patients.length)];
  for (const [path, name] of [
    [`/api/patients/${patientId}/therapy`, 'therapy'],
    [`/api/patients/${patientId}/cards`, 'cards'],
    [`/api/patients/${patientId}/timeline`, 'timeline'],
    ['/api/alerts', 'alerts'],
  ]) {
    const response = get(path, doctor.token, name);
    check(response, { [`${name} 200`]: (r) => r.status === 200 });
  }
  // Think time: a person reads the screen between clicks.
  sleep(2);
}

const PHQ9_ITEMS = Array.from({ length: 9 }, (_, i) => `phq9_0${String(i + 1)}`);

export function patientFlow(data) {
  const patient = data.patients[(__VU - 1) % data.patients.length];
  check(get(`/api/patients/${patient.id}/scales`, patient.token, 'scales'), {
    'scales 200': (r) => r.status === 200,
  });
  // One in ten answers is item 9 > 0: the critical alert path runs under load too.
  const item9 = Math.random() < 0.1 ? 1 : 0;
  const body = {
    submissionId: uuid(),
    answers: Object.fromEntries(PHQ9_ITEMS.map((id) => [id, id === 'phq9_09' ? item9 : 0])),
    functionalAnswer: 0,
  };
  const path = `/api/patients/${patient.id}/scales/phq9/responses`;
  const first = post(path, body, patient.token, 'phq9 submit');
  const retry = post(path, body, patient.token, 'phq9 retry');
  check(first, { 'phq9 accepted': (r) => r.status === 201 || r.status === 200 });
  check(retry, {
    'phq9 retry is idempotent': (r) =>
      (r.status === 200 || r.status === 201) && r.json('responseId') === first.json('responseId'),
  });
  const dose = post(
    `/api/patients/${patient.id}/medications/${patient.medicationId}/doses`,
    { scheduledFor: patient.slot, status: 'taken' },
    patient.token,
    'dose mark',
  );
  check(dose, { 'dose mark 200 (repeat is a no-op)': (r) => r.status === 200 });
  check(get(`/api/patients/${patient.id}/therapy`, patient.token, 'patient therapy'), {
    'patient therapy 200': (r) => r.status === 200,
  });
  sleep(2);
}
