const config = require('../config');

/**
 * Supabase REST API 공통 fetch 헬퍼
 */
async function supabaseFetch(path) {
  const url = `${config.supabase.url}${path}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'apikey': config.supabase.key,
      'Authorization': `Bearer ${config.supabase.key}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`Supabase API request failed: ${response.status} ${response.statusText}`);
  }

  return await response.json();
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

module.exports = {
  checkIsHoliday,
  getApprovedLeaves,
  getApprovedBusinessTrips
};
