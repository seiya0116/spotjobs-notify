const https = require('https');
const fs = require('fs');

const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK;
const EMAIL = process.env.SPOTJOBS_EMAIL;
const PASSWORD = process.env.SPOTJOBS_PASSWORD;
const FIREBASE_KEY = 'AizaSyBHcAHwfuZbPT5a2sY15yVVBkH5ZyNU67k';
const RADIUS_METERS = 1000;
const NOTIFIED_FILE = 'notified_ids.json';

const lat = parseFloat(process.env.LATITUDE || process.env.DEFAULT_LAT);
const lng = parseFloat(process.env.LONGITUDE || process.env.DEFAULT_LNG);

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function httpsPost(urlStr, body, headers) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const data = JSON.stringify(body);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }, headers || {})
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function getFirebaseToken() {
  console.log('Firebaseログイン中...');
  const url = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + FIREBASE_KEY;
  const res = await httpsPost(url, {
    returnSecureToken: true,
    email: EMAIL,
    password: PASSWORD,
    clientType: 'CLIENT_TYPE_WEB'
  });

  if (res.status !== 200) {
    throw new Error('Firebaseログイン失敗: ' + res.status + ' ' + res.body);
  }

  const data = JSON.parse(res.body);
  console.log('Firebaseトークン取得成功');
  return data.idToken;
}

async function getSpotJobsToken(firebaseToken) {
  console.log('SpotJobsトークン取得中...');
  const url = 'https://spotjobs-api.spotapi.jp/api/v1/auth/login';
  const res = await httpsPost(url, { idToken: firebaseToken }, {
    'Origin': 'https://app.spot.jobs',
    'Referer': 'https://app.spot.jobs/'
  });

  console.log('SpotJobsログインステータス: ' + res.status);
  console.log('SpotJobsログインレスポンス: ' + res.body.substring(0, 200));

  if (res.status === 200) {
    const data = JSON.parse(res.body);
    return data.token || data.accessToken || data.idToken || null;
  }
  return null;
}

function getDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = deg => deg * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function translateWorkType(type) {
  const map = {
    BATTERY_INSERT: 'バッテリー挿入',
    BATTERY_EJECT: 'バッテリー取出',
    SPOT_REQUEST_COLLECT: 'スポット回収',
    BATTERY_RETURN: 'バッテリー返却'
  };
  return map[type] || type || '不明';
}

function loadNotifiedIds() {
  try {
    if (fs.existsSync(NOTIFIED_FILE)) {
      return JSON.parse(fs.readFileSync(NOTIFIED_FILE, 'utf8'));
    }
  } catch (e) {}
  return [];
}

function saveNotifiedIds(ids) {
  fs.writeFileSync(NOTIFIED_FILE, JSON.stringify(ids.slice(-300)));
}

async function sendSlack(text) {
  await httpsPost(SLACK_WEBHOOK, { text });
}

async function main() {
  if (!SLACK_WEBHOOK || !EMAIL || !PASSWORD) {
    console.error('必要なSecretsが設定されていません');
    process.exit(1);
  }

  if (isNaN(lat) || isNaN(lng)) {
    console.error('緯度経度が取得できませんでした');
    process.exit(1);
  }

  console.log('現在地: ' + lat + ', ' + lng);

  // Step1: Firebaseでログイン
  const firebaseToken = await getFirebaseToken();

  // Step2: SpotJobsのトークンを取得（失敗してもFirebaseトークンで試みる）
  let bearerToken = await getSpotJobsToken(firebaseToken);
  if (!bearerToken) {
    console.log('SpotJobsトークン取得失敗、Firebaseトークンで直接試みます');
    bearerToken = firebaseToken;
  }

  // Step3: ジョブ一覧を取得
  const workTypes = 'BATTERY_INSERT%2CBATTERY_EJECT%2CSPOT_REQUEST_COLLECT%2CBATTERY_RETURN';
  const url = 'https://spotjobs-api.spotapi.jp/api/v1/work'
    + '?pageNum=1&pageSize=100'
    + '&lat=' + lat
    + '&lng=' + lng
    + '&workTypes=' + workTypes
    + '&sortType=REWARD';

  const res = await httpsGet(url, {
    'Authorization': 'Bearer ' + bearerToken,
    'Accept': '*/*',
    'Origin': 'https://app.spot.jobs',
    'Referer': 'https://app.spot.jobs/'
  });

  console.log('APIステータス: ' + res.status);
  console.log('レスポンス(先頭300文字): ' + res.body.substring(0, 300));

  if (res.status !== 200) {
    console.error('APIエラー: ' + res.status);
    process.exit(1);
  }

  let jobs;
  try {
    const data = JSON.parse(res.body);
    jobs = data.content || data.items || data.works || data || [];
  } catch (e) {
    console.error('JSONパース失敗: ' + e.message);
    process.exit(1);
  }

  console.log('取得ジョブ数: ' + jobs.length);

  const nearbyJobs = jobs.filter(job => {
    const jobLat = job.latitude || job.lat || job.spotLatitude;
    const jobLng = job.longitude || job.lng || job.spotLongitude;
    if (!jobLat || !jobLng) return false;
    const dist = getDistance(lat, lng, jobLat, jobLng);
    job._distance = dist;
    return dist <= RADIUS_METERS;
  });

  console.log('1km以内: ' + nearbyJobs.length);

  const notifiedIds = loadNotifiedIds();
  const newJobs = nearbyJobs.filter(job => {
    const id = String(job.id || job.workId || job.spotId || '');
    return id && !notifiedIds.includes(id);
  });

  console.log('新着: ' + newJobs.length);

  for (const job of newJobs) {
    const distance = Math.round(job._distance);
    const reward = job.reward || job.point || job.rewardPoint || '?';
    const address = job.address || job.spotAddress || job.location || '住所不明';
    const workType = translateWorkType(job.workType || job.type || '');

    const text = '新しいジョブが近くにあります!\n'
      + '種別: ' + workType + '\n'
      + '場所: ' + address + '\n'
      + '報酬: ' + reward + 'pt\n'
      + '距離: 約' + distance + 'm\n'
      + 'URL: https://app.spot.jobs/';

    await sendSlack(text);
    console.log('通知送信: ' + address + ' (' + distance + 'm)');
  }

  if (newJobs.length > 0) {
    const newIds = newJobs.map(j => String(j.id || j.workId || j.spotId || ''));
    saveNotifiedIds([...notifiedIds, ...newIds]);
  }

  console.log('完了');
}

main().catch(e => {
  console.error('エラー: ' + e.message);
  process.exit(1);
});
