const config = require('../config');

/**
 * Supabase 키 종류를 판별합니다. 키 값은 어디에도 출력하지 않습니다.
 *  - 'secret'       : 새 형식 서버 키 (sb_secret_…)
 *  - 'service_role' : 예전 형식 서버 키 (JWT)
 *  - 그 밖('anon', 'publishable', 'missing', 'unknown')은 서버 키가 아닙니다.
 */
function getKeyKind(key) {
  if (!key) return 'missing';
  if (key.startsWith('sb_secret_')) return 'secret';
  if (key.startsWith('sb_publishable_')) return 'publishable';
  try {
    const payload = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8'));
    return payload.role || 'unknown';
  } catch (error) {
    return 'unknown';
  }
}

const KEY_KIND = getKeyKind(config.supabase.key);
const HAS_SERVER_KEY = KEY_KIND === 'secret' || KEY_KIND === 'service_role';

if (!HAS_SERVER_KEY) {
  const message = `[Supabase] 서버 전용 키가 아닙니다(현재: ${KEY_KIND}). 휴가·출장·공휴일 조회와 이미지 업로드를 할 수 없습니다.`;
  // 자동 실행에서는 조용히 넘어가지 않고 실행을 실패시킵니다.
  // 키가 맞지 않으면 조회가 빈 결과로 끝나, 휴가자에게 독려 DM이 가는 틀린 브리핑이 나갈 수 있습니다.
  if (process.env.GITHUB_ACTIONS === 'true') {
    throw new Error(`${message} GitHub Actions secret SUPABASE_KEY 를 확인하세요.`);
  }
  console.warn(`${message} 로컬 실행이므로 Supabase 기능만 건너뛰고 계속합니다.`);
}

/**
 * Supabase 요청 공통 헤더
 */
function authHeaders(extra = {}) {
  return {
    apikey: config.supabase.key,
    Authorization: `Bearer ${config.supabase.key}`,
    ...extra
  };
}

/**
 * leave.type DB 코드값 -> 보고용 한글 라벨 매핑
 * (슬랙 브리핑에 half_pm 같은 코드값이 그대로 노출되는 문제 방지)
 */
const LEAVE_TYPE_LABELS = {
  annual: '연차',
  full: '연차',
  half_am: '오전반차',
  half_pm: '오후반차',
  official: '공가',
  sick: '병가',
  special: '경조휴가'
};

/**
 * 연차 타입 코드를 한글 라벨로 변환합니다. 매핑에 없는 값은 원문을 그대로 반환합니다.
 */
function formatLeaveType(type) {
  if (!type) return '';
  const key = String(type).trim().toLowerCase();
  if (LEAVE_TYPE_LABELS[key]) return LEAVE_TYPE_LABELS[key];
  // 이미 한글로 들어온 경우(연차/오전반차 등)는 그대로 사용
  return String(type).trim();
}

/**
 * Supabase REST API 공통 fetch 헬퍼
 */
async function supabaseFetch(path) {
  if (!HAS_SERVER_KEY) throw new Error('서버 전용 키가 없어 조회를 건너뜁니다.');
  const url = `${config.supabase.url}${path}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Supabase API request failed: ${response.status} ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

/**
 * 특정 날짜가 공휴일인지 확인합니다.
 */
async function checkIsHoliday(date) {
  try {
    const data = await supabaseFetch(`/rest/v1/holidays?date=eq.${date}&select=name`);
    return data && data.length > 0;
  } catch (error) {
    console.error(`[Supabase] 공휴일 조회 실패 (${date}):`, error.message);
    return false;
  }
}

/**
 * 특정 날짜에 승인된 휴가(leave) 목록을 가져옵니다.
 * 반환값: { [user_email(lowercase)]: '연차' | '오전반차' | '오후반차' | '공가' ... } (한글 라벨)
 * - 출장 이관분(biztrip_migrated)은 연차가 아니므로 제외합니다.
 */
async function getApprovedLeaves(date) {
  try {
    const data = await supabaseFetch(`/rest/v1/leave?status=eq.approved&type=neq.biztrip_migrated&start_date=lte.${date}&end_date=gte.${date}&select=user_email,type`);
    // 이메일을 key로, 한글 라벨을 value로 가지는 맵 반환
    const leaveMap = {};
    if (data && data.length > 0) {
      data.forEach(item => {
        if (item.user_email) {
          leaveMap[item.user_email.trim().toLowerCase()] = formatLeaveType(item.type);
        }
      });
    }
    return leaveMap;
  } catch (error) {
    console.error(`[Supabase] 휴가 승인 목록 조회 실패 (${date}):`, error.message);
    return {};
  }
}

/**
 * 특정 날짜에 승인된 출장(business_trips) 목록을 가져옵니다.
 * 반환값: Map<출장자 이름(신청자 및 동반 출장자), { destination, purpose }>
 * - 출장도 한슬 업무이므로 출장 종류와 관계없이 일지 작성 대상입니다. (상태 라벨 표시용)
 */
async function getApprovedBusinessTrips(date) {
  try {
    const data = await supabaseFetch(`/rest/v1/business_trips?approval_status=eq.approved&trip_start_date=lte.${date}&trip_end_date=gte.${date}&select=requester_name,travelers,companions,trip_purpose,trip_destination`);

    const tripMap = new Map();
    (data || []).forEach(item => {
      const travelersList = new Set();
      if (item.requester_name) {
        travelersList.add(item.requester_name.trim());
      }
      if (Array.isArray(item.travelers)) {
        item.travelers.forEach(name => {
          if (name) travelersList.add(name.trim());
        });
      }
      if (Array.isArray(item.companions)) {
        item.companions.forEach(comp => {
          if (comp && comp.name) travelersList.add(comp.name.trim());
        });
      }

      travelersList.forEach(name => {
        if (!tripMap.has(name)) {
          tripMap.set(name, {
            destination: (item.trip_destination || '').trim(),
            purpose: (item.trip_purpose || '').trim()
          });
        }
      });
    });
    return tripMap;
  } catch (error) {
    console.error(`[Supabase] 출장 승인 목록 조회 실패 (${date}):`, error.message);
    return new Map();
  }
}

/**
 * 외부 이미지 URL을 다운로드하여 Supabase Storage 'workplan' 버킷에 업로드하고, 영구 Public URL을 반환합니다.
 */
async function uploadImageToStorage(imageUrl) {
  if (!HAS_SERVER_KEY) return imageUrl; // 로컬 실행: 업로드 없이 원본 주소 유지
  try {
    // 1. 이미지 다운로드 (5초 타임아웃)
    const downloadController = new AbortController();
    const downloadTimeout = setTimeout(() => downloadController.abort(), 5000);
    
    const response = await fetch(imageUrl, { signal: downloadController.signal });
    clearTimeout(downloadTimeout);
    
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
    }
    
    const contentType = response.headers.get('content-type') || 'image/png';
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    // 확장자 유추
    let ext = 'png';
    if (contentType.includes('jpeg') || contentType.includes('jpg')) ext = 'jpg';
    else if (contentType.includes('gif')) ext = 'gif';
    else if (contentType.includes('webp')) ext = 'webp';
    else if (contentType.includes('svg')) ext = 'svg';

    // 고유 파일명 생성
    const timestamp = Date.now();
    const randomSuffix = Math.random().toString(36).substring(2, 9);
    const fileName = `workplan-logs/${timestamp}_${randomSuffix}.${ext}`;
    
    // 2. Supabase Storage API로 업로드 (POST /storage/v1/object/workplan/filePath) - 10초 타임아웃
    const uploadUrl = `${config.supabase.url}/storage/v1/object/workplan/${fileName}`;
    const uploadController = new AbortController();
    const uploadTimeout = setTimeout(() => uploadController.abort(), 10000);
    
    const uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': contentType, 'x-upsert': 'true' }),
      body: buffer,
      signal: uploadController.signal
    });
    clearTimeout(uploadTimeout);
    
    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      throw new Error(`Supabase Storage upload failed: ${uploadResponse.status} ${errorText}`);
    }
    
    // 3. 영구 Public URL 생성 및 리턴
    const publicUrl = `${config.supabase.url}/storage/v1/object/public/workplan/${fileName}`;
    console.log(`[Supabase Storage] 이미지 업로드 성공: ${imageUrl} -> ${publicUrl}`);
    return publicUrl;
  } catch (error) {
    console.error(`[Supabase Storage] 이미지 업로드 실패 (원본 URL 유지):`, error.message);
    return imageUrl; // 실패 시 원본 임시 URL 유지
  }
}

module.exports = {
  LEAVE_TYPE_LABELS,
  formatLeaveType,
  checkIsHoliday,
  getApprovedLeaves,
  getApprovedBusinessTrips,
  uploadImageToStorage
};
