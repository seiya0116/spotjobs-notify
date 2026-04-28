const https = require('https');
const fs = require('fs');

const BEARER_TOKEN = process.env.BEARER_TOKEN;
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK;
const lat = parseFloat(process.env.LATITUDE);
const lng = parseFloat(process.env.LONGITUDE);
const RADIUS_METERS = 1000;
const NOTIFIED_FILE = 'notified_ids.json';

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

function httpsPost(urlStr, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const data = JSON.stringify(body);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
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

async function main() {
  if (!BEARER_TOKEN || !SLACK_WEBHOOK) {
    console.error('Secretsが設定されていません');
    process.exit(1);
  }

  if (isNaN(lat) || isNaN(lng)) {
    console.error('緯度経度が取得できませんでした lat=' + process.env.LATITUDE + ' lng=' + process.env.LONGITUDE);
    process.exit(1);
  }

  console.log('現在地: ' + lat + ', ' + lng);

  const workTypes = 'BATTERY_INSERT%2CBATTERY_EJECT%2CSPOT_REQUEST_COLLECT%2CBATTERY_RETURN';
  const url = 'https://spotjobs-api.spotapi.jp/api/v1/work'
    + '?pageNum=1&pageSize=100'
    + '&lat=' + lat
    + '&lng=' + lng
    + '&workTypes=' + workTypes
    + '&sortType=REWARD';

  const res = await httpsGet(url, {
    'Authorization': 'Bearer ' + BEARER_TOKEN,
    'Accept': '*/*',
    'Origin': 'https://app.spot.jobs',
    'Referer': 'https://app.spot.jobs/'
  });

  console.log('ステータス: ' + res.status);
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

    await httpsPost(SLACK_WEBHOOK, { text });
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
