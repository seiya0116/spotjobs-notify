const https = require('https');
const fs = require('fs');

const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK;
const BEARER_TOKEN = process.env.BEARER_TOKEN;
const RADIUS_METERS = 1000;
const AUTO_RESERVE_RADIUS_SINGLE = 500;
const AUTO_RESERVE_RADIUS_MULTI = 600;

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

async function reserveJob(workId) {
  const url = 'https://spotjobs-api.spotapi.jp/api/v1/work/' + workId + '/reservation';
  const res = await httpsPost(url, {}, {
    'Authorization': 'Bearer ' + BEARER_TOKEN,
    'Accept': '*/*',
    'Origin': 'https://app.spot.jobs',
    'Referer': 'https://app.spot.jobs/'
  });
  console.log('予約APIステータス: ' + res.status);
  console.log('予約APIレスポンス: ' + res.body);
  return res.status === 200;
}

async function sendSlack(text) {
  await httpsPost(SLACK_WEBHOOK, { text });
}

async function main() {
  if (!SLACK_WEBHOOK || !BEARER_TOKEN) {
    console.error('必要なSecretsが設定されていません');
    process.exit(1);
  }

  if (isNaN(lat) || isNaN(lng)) {
    console.error('緯度経度が取得できませんでした');
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

  console.log('APIステータス: ' + res.status);

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

  // 距離計算・グレー除外
  const availableJobs = jobs.filter(job => {
    const jobLat = job.lat || job.latitude || job.spotLatitude;
    const jobLng = job.lng || job.longitude || job.spotLongitude;
    if (!jobLat || !jobLng) return false;

    // グレー（他の人が予約済み）を除外
    if (job.reserved === 'RESERVED_BY_OTHERS') return false;

    const dist = getDistance(lat, lng, jobLat, jobLng);
    job._distance = dist;
    return dist <= RADIUS_METERS;
  });

  console.log('1km以内・予約可能: ' + availableJobs.length);

  const notifiedIds = loadNotifiedIds();
  const newJobs = availableJobs.filter(job => {
    const id = String(job.workId || job.id || job.spotId || '');
    return id && !notifiedIds.includes(id);
  });

  console.log('新着: ' + newJobs.length);

  for (const job of newJobs) {
    const distance = Math.round(job._distance);
    const reward = job.expectedReward || job.reward || job.point || '?';
    const address = job.address || job.spotAddress || '住所不明';
    const spotName = job.spotDetail && job.spotDetail.spotName ? job.spotDetail.spotName : '';
    const workType = translateWorkType(job.workType || '');
    const workId = job.workId || job.id;

    // バッテリー取出の自動予約判定
    // 取出本数はbatteryExpectedの絶対値（BATTERY_EJECTはマイナス値）
    const batteryCount = job.batteryAdjustmentDetail
      ? Math.abs(job.batteryAdjustmentDetail.batteryExpected || 0)
      : 0;
    const isMulti = batteryCount >= 2;
    const shouldAutoReserve = job.workType === 'BATTERY_EJECT'
      && (distance <= AUTO_RESERVE_RADIUS_SINGLE || (isMulti && distance <= AUTO_RESERVE_RADIUS_MULTI));

    if (shouldAutoReserve) {
      console.log('自動予約試みる: ' + address);
      const success = await reserveJob(workId);
      if (success) {
        const text = '自動予約しました!\n'
          + '種別: ' + workType + '\n'
          + '場所: ' + (spotName || address) + '\n'
          + '住所: ' + address + '\n'
          + '報酬: ' + reward + '円\n'
          + '距離: 約' + distance + 'm\n'
          + 'URL: https://app.spot.jobs/';
        await sendSlack(text);
      } else {
        const text = '予約失敗しました\n'
          + '種別: ' + workType + '\n'
          + '場所: ' + (spotName || address) + '\n'
          + '距離: 約' + distance + 'm\n'
          + 'URL: https://app.spot.jobs/';
        await sendSlack(text);
      }
    } else {
      // 通常通知
      const text = '新しいジョブが近くにあります!\n'
        + '種別: ' + workType + '\n'
        + '場所: ' + (spotName || address) + '\n'
        + '住所: ' + address + '\n'
        + '報酬: ' + reward + '円\n'
        + '距離: 約' + distance + 'm\n'
        + 'URL: https://app.spot.jobs/';
      await sendSlack(text);
    }

    console.log('処理完了: ' + address + ' (' + distance + 'm)');
  }

  if (newJobs.length > 0) {
    const newIds = newJobs.map(j => String(j.workId || j.id || j.spotId || ''));
    saveNotifiedIds([...notifiedIds, ...newIds]);
  }

  console.log('完了');
}

main().catch(e => {
  console.error('エラー: ' + e.message);
  process.exit(1);
});
