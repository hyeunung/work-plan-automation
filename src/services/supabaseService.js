const config = require('../config');

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
  const url = `${config.supabase.url}${path}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'apikey': config.supabase.key,
        'Authorization': `Bearer ${config.supabase.key}`,
        'Content-Type': 'application/json'
      },
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
 * 반환값: 출장자 이름(신청자 및 동반 출장자)들의 Set
 */
async function getApprovedBusinessTrips(date) {
  try {
    const data = await supabaseFetch(`/rest/v1/business_trips?approval_status=eq.approved&trip_start_date=lte.${date}&trip_end_date=gte.${date}&select=requester_name,travelers,companions,project_name,trip_purpose,trip_destination`);
    
    const tripMap = new Map();
    if (data && data.length > 0) {
      const smartFarmKeywords = ['스마트팜', '청송', '농장', '온실', '대차', '방제', '원격제어', '원격 제어', '주행', '생육', '제어', '센서', '하이브리드'];
      
      data.forEach(item => {
        const proj = item.project_name || '';
        const purp = item.trip_purpose || '';
        const dest = item.trip_destination || '';
        
        const isSmartFarm = smartFarmKeywords.some(kw => 
          proj.includes(kw) || purp.includes(kw) || dest.includes(kw)
        );
        
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
            if (comp && comp.name) {
              travelersList.add(comp.name.trim());
            }
          });
        }
        
        travelersList.forEach(name => {
          const existing = tripMap.get(name);
          tripMap.set(name, {
            isSmartFarm: existing ? (existing.isSmartFarm || isSmartFarm) : isSmartFarm
          });
        });
      });
    }
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
      headers: {
        'apikey': config.supabase.key,
        'Authorization': `Bearer ${config.supabase.key}`,
        'Content-Type': contentType,
        'x-upsert': 'true'
      },
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
