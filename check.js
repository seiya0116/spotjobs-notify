const https = require('https');
const fs = require('fs');

const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK;
const BEARER_TOKEN = process.env.BEARER_TOKEN;
const RADIUS_METERS = 2000;
const NOTIFIED_FILE = 'notified_ids.json';
const CONVENIENCE_STORES = ['セブン-イレブン', 'ファミリーマート', 'ローソン'];

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

function isConvenienceStore(spotName) {
  if (!spotName) return false;
  return CONVENIENCE_STORES.some(store => spotName.includes(store));
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

// 夜間かどうか判定（22:00〜7:00 JST）
function isNightTime(jstTime) {
  const hour = jstTime.getHours();
  return hour >= 22 || hour < 7;
}

// 日本の祝日を取得
async function getJapaneseHolidays(year) {
  try {
    const url = 'https://date.nager.at/api/v3/PublicHolidays/' + year + '/JP';
    const res = await httpsGet(url, { 'Accept': 'application/json' });
    if (res.status === 200) {
      const holidays = JSON.parse(res.body);
      return holidays.map(h => h.date);
    }
  } catch (e) {
    console.log('祝日取得失敗: ' + e.message);
  }
  return [];
}

// 定休日判定
function isClosed(description, today, dayOfWeek, isHoliday) {
  if (!description) return false;
  if (!description.includes('定休日')) return false;

  const closedMatch = description.match(/定休日[：:　\s]*([^\n]+)/);
  if (!closedMatch) return false;
  const closedText = closedMatch[1];

  const dayMap = {
    '月': 1, '火': 2, '水': 3, '木': 4, '金': 5, '土': 6, '日': 0,
    '月曜': 1, '火曜': 2, '水曜': 3, '木曜': 4, '金曜': 5, '土曜': 6, '日曜': 0,
    '月曜日': 1, '火曜日': 2, '水曜日': 3, '木曜日': 4, '金曜日': 5, '土曜日': 6, '日曜日': 0
  };

  if (isHoliday && (closedText.includes('祝') || closedText.includes('祝日'))) return true;

  if (closedText.includes('土日祝') || closedText.includes('土・日・祝')) {
    if (isHoliday) return true;
    if (dayOfWeek === 0 || dayOfWeek === 6) return true;
  }

  const nthDayMatch = closedText.match(/第([１２３４1234])([月火水木金土日])/);
  if (nthDayMatch) {
    const nthMap = { '１': 1, '２': 2, '３': 3, '４': 4, '1': 1, '2': 2, '3': 3, '4': 4 };
    const nth = nthMap[nthDayMatch[1]];
    const targetDay = dayMap[nthDayMatch[2]];
    if (targetDay === dayOfWeek) {
      const weekOfMonth = Math.ceil(today.getDate() / 7);
      if (weekOfMonth === nth) return true;
    }
  }

  for (const [key, value] of Object.entries(dayMap)) {
    if (closedText.includes(key) && value === dayOfWeek) return true;
  }

  return false;
}

async function getMyBatteryCount() {
  const url = 'https://spotjobs-api.spotapi.jp/api/v1/battery/list'
    + '?pageNum=1&pageSize=1&batteryStatus=ALL&timeFilter=ALL&sortType=UPDATE_TIME_DESC';
  const res = await httpsGet(url, {
    'Authorization': 'Bearer ' + BEARER_TOKEN,
    'Accept': '*/*',
    'Origin': 'https://app.spot.jobs',
    'Referer': 'https://app.spot.jobs/'
  });
  if (res.status !== 200) {
    console.log('バッテリー所持数取得失敗: ' + res.status);
    return 0;
  }
  try {
    const data = JSON.parse(res.body);
    const count = parseInt(data.totalCount || 0);
    console.log('所持バッテリー数: ' + count);
    return count;
  } catch (e) {
    console.log('バッテリー所持数パース失敗: ' + e.message);
    return 0;
  }
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

  // JSTの現在時刻
  const now = new Date();
  const jstOffset = 9 * 60;
  const jstTime = new Date(now.getTime() + (jstOffset - now.getTimezoneOffset()) * 60000);
  const dayOfWeek = jstTime.getDay();
  const todayStr = jstTime.toISOString().split('T')[0];
  const year = jstTime.getFullYear();
  const nightTime = isNightTime(jstTime);

  // 夜間・日中の距離設定
  const EJECT_RADIUS_SINGLE = nightTime ? 300 : 500;
  const EJECT_RADIUS_MULTI = nightTime ? 300 : 600;
  const INSERT_RADIUS = nightTime ? 300 : 500;

  console.log('時間帯: ' + (nightTime ? '夜間(300m)' : '日中') + ' JST時刻: ' + jstTime.getHours() + '時');

  // 祝日取得
  const holidays = await getJapaneseHolidays(year);
  const isHoliday = holidays.includes(todayStr);
  console.log('今日: ' + todayStr + ' 曜日: ' + dayOfWeek + ' 祝日: ' + isHoliday);

  // 所持バッテリー数を取得
  const myBatteryCount = await getMyBatteryCount();

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

  const availableJobs = jobs.filter(job => {
    const jobLat = job.lat || job.latitude || job.spotLatitude;
    const jobLng = job.lng || job.longitude || job.spotLongitude;
    if (!jobLat || !jobLng) return false;
    if (job.reserved === 'RESERVED_BY_OTHERS') return false;
    if (job.rounderWorkState === 'RESERVED') return false;
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
    const description = job.spotDetail && job.spotDetail.description ? job.spotDetail.description : '';
    const workType = translateWorkType(job.workType || '');
    const workId = job.workId || job.id;

    // 定休日チェック
    const closedToday = isClosed(description, jstTime, dayOfWeek, isHoliday);
    if (closedToday) {
      console.log('定休日のためスキップ: ' + spotName);
      continue;
    }

    let shouldAutoReserve = false;

    if (job.workType === 'BATTERY_EJECT') {
      const batteryCount = job.batteryAdjustmentDetail
        ? Math.abs(job.batteryAdjustmentDetail.batteryExpected || 0)
        : 0;

      if (batteryCount < 2) {
        console.log('取出1本のためスキップ: ' + spotName);
        // 通知もしない
        const id = String(job.workId || job.id || '');
        if (id && !notifiedIds.includes(id)) notifiedIds.push(id);
        continue;
      } else if (batteryCount >= 3) {
        // 3本以上: どの店舗でもOK
        shouldAutoReserve = distance <= EJECT_RADIUS_SINGLE
          || distance <= EJECT_RADIUS_MULTI;
      } else {
        // 2本: コンビニのみ
        const isConveni = isConvenienceStore(spotName);
        shouldAutoReserve = isConveni && (
          distance <= EJECT_RADIUS_SINGLE || distance <= EJECT_RADIUS_MULTI
        );
        if (!isConveni) console.log('2本取出だがコンビニ以外のためスキップ: ' + spotName);
      }

    } else if (job.workType === 'BATTERY_INSERT') {
      const needed = job.batteryAdjustmentDetail
        ? job.batteryAdjustmentDetail.batteryExpected || 0
        : 0;
      const isConveni = isConvenienceStore(spotName);
      shouldAutoReserve = myBatteryCount >= 2
        && needed >= 2
        && needed <= myBatteryCount
        && distance <= INSERT_RADIUS
        && isConveni;

      if (shouldAutoReserve) {
        console.log('挿入自動予約条件: 所持=' + myBatteryCount + '本 必要=' + needed + '本 店舗=' + spotName);
      }
    }

    if (shouldAutoReserve) {
      console.log('自動予約試みる: ' + spotName + ' (' + distance + 'm)');
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
