const config = require('../config');

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
 */
async function getApprovedLeaves(date) {
  try {
    const data = await supabaseFetch(`/rest/v1/leave?status=eq.approved&start_date=lte.${date}&end_date=gte.${date}&select=user_email,type`);
    // 이메일을 key로, 타입을 value로 가지는 맵 반환
    const leaveMap = {};
    if (data && data.length > 0) {
      data.forEach(item => {
        if (item.user_email) {
          leaveMap[item.user_email.trim().toLowerCase()] = item.type;
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
 */
async function getApprovedBusinessTrips(date) {
  try {
    // PostgREST 조인 구문 활용: requester_id에 연결된 employees 테이블의 email 조회 (외래키 모호성 해결 위해 !requester_id 명시)
    const data = await supabaseFetch(`/rest/v1/business_trips?approval_status=eq.approved&trip_start_date=lte.${date}&trip_end_date=gte.${date}&select=requester_name,employees!requester_id(email)`);
    
    const tripEmails = new Set();
    if (data && data.length > 0) {
      data.forEach(item => {
        const email = item.employees?.email;
        if (email) {
          tripEmails.add(email.trim().toLowerCase());
        }
      });
    }
    return tripEmails;
  } catch (error) {
    console.error(`[Supabase] 출장 승인 목록 조회 실패 (${date}):`, error.message);
    return new Set();
  }
}

/**
 * 외부 이미지 URL을 다운로드하여 Supabase Storage 'workplan' 버킷에 업로드하고, 영구 Public URL을 반환합니다.
 */
async function uploadImageToStorage(imageUrl) {
  try {
    // 1. 이미지 다운로드
    const response = await fetch(imageUrl);
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
    
    // 2. Supabase Storage API로 업로드 (POST /storage/v1/object/workplan/filePath)
    const uploadUrl = `${config.supabase.url}/storage/v1/object/workplan/${fileName}`;
    const uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'apikey': config.supabase.key,
        'Authorization': `Bearer ${config.supabase.key}`,
        'Content-Type': contentType,
        'x-upsert': 'true'
      },
      body: buffer
    });
    
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
  checkIsHoliday,
  getApprovedLeaves,
  getApprovedBusinessTrips,
  uploadImageToStorage
};

